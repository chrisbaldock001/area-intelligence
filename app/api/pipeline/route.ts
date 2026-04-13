import { NextResponse } from 'next/server'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

interface ScrapedApplication {
    ref: string
    address: string
    proposal: string
    validated: string
    status: string
    link: string
}

async function scrapeWeek(fromDate: Date, toDate: Date): Promise<ScrapedApplication[]> {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    try {
        const fmt = (d: Date) => d.toLocaleDateString('en-GB')

        await page.goto('https://applications.greatercambridgeplanning.org/online-applications/search.do?action=advanced')
        await page.waitForLoadState('networkidle')
        await page.waitForSelector('input[type="submit"][value="Search"]', { timeout: 10000 })
        await page.fill('input[name="date(applicationValidatedStart)"]', fmt(fromDate))
        await page.fill('input[name="date(applicationValidatedEnd)"]', fmt(toDate))
        await page.waitForTimeout(500)
        await page.click('input[type="submit"][value="Search"]')
        await page.waitForLoadState('networkidle')

        // Check if results exist
        const hasResults = await page.$('li.searchresult')
        if (!hasResults) {
            await browser.close()
            return []
        }

        const applications = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('li.searchresult')).map(el => {
                const metaText = el.querySelector('p.metaInfo')?.textContent ?? ''
                const refMatch = metaText.match(/Ref\. No:\s*(\S+)/)
                const validatedMatch = metaText.match(/Validated:\s*(.+?)\s*\|/)
                const statusMatch = metaText.match(/Status:\s*([^\n]+)/)
                return {
                    ref: refMatch?.[1]?.trim() ?? '',
                    address: el.querySelector('p.address')?.textContent?.trim() ?? '',
                    proposal: el.querySelector('div.summaryLinkTextClamp')?.textContent?.trim() ?? '',
                    validated: validatedMatch?.[1]?.trim() ?? '',
                    status: statusMatch?.[1]?.trim() ?? '',
                    link: el.querySelector('a')?.getAttribute('href') ?? ''
                }
            })
        })

        await browser.close()
        return applications

    } catch (err) {
        await browser.close()
        console.error('Scrape error:', err)
        return []
    }
}

export async function GET(request: Request) {
    try {
        const url = new URL(request.url)
        const weeks = parseInt(url.searchParams.get('weeks') ?? '4')

        const today = new Date()
        let allApplications: ScrapedApplication[] = []

        // Scrape week by week
        for (let i = 0; i < weeks; i++) {
            const toDate = new Date(today)
            toDate.setDate(today.getDate() - (i * 7))
            const fromDate = new Date(toDate)
            fromDate.setDate(toDate.getDate() - 7)

            console.log(`Scraping week ${i + 1}: ${fromDate.toLocaleDateString('en-GB')} to ${toDate.toLocaleDateString('en-GB')}`)

            const weekApplications = await scrapeWeek(fromDate, toDate)
            allApplications = allApplications.concat(weekApplications)
        }

        // Deduplicate by ref
        const seen = new Set()
        const unique = allApplications.filter(app => {
            if (seen.has(app.ref)) return false
            seen.add(app.ref)
            return true
        })

        // Summarise and store
        const results = []

        for (const app of unique) {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-opus-4-5',
                    max_tokens: 300,
                    messages: [{
                        role: 'user',
                        content: `You are helping local residents understand planning applications in plain English.

Summarise this planning application in 2-3 sentences a non-expert would understand. Focus on what is actually happening, where, and what impact it might have on the local area. Avoid jargon.

Reference: ${app.ref}
Address: ${app.address}
Proposal: ${app.proposal}
Status: ${app.status}`
                    }]
                })
            })

            const data = await response.json()
            const summary = data.content?.[0]?.text ?? ''

            const { error } = await supabase
                .from('applications')
                .upsert({
                    ref: app.ref,
                    address: app.address,
                    proposal: app.proposal,
                    status: app.status,
                    validated: app.validated,
                    link: app.link,
                    summary,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'ref' })

            results.push({
                ref: app.ref,
                address: app.address,
                summary,
                stored: !error,
                error: error?.message
            })
        }

        return NextResponse.json({ weeks, scraped: allApplications.length, unique: unique.length, stored: results.length, results })

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}