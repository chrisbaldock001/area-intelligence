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

async function scrapePostcode(postcode: string, fromDate: Date, toDate: Date): Promise<ScrapedApplication[]> {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    try {
        const fmt = (d: Date) => d.toLocaleDateString('en-GB')

        await page.goto('https://applications.greatercambridgeplanning.org/online-applications/search.do?action=advanced')
        await page.waitForLoadState('networkidle')
        await page.waitForSelector('input[type="submit"][value="Search"]', { timeout: 10000 })

        await page.fill('input[name="date(applicationValidatedStart)"]', fmt(fromDate))
        await page.fill('input[name="date(applicationValidatedEnd)"]', fmt(toDate))
        await page.fill('input[name="searchCriteria.address"]', postcode)
        await page.waitForTimeout(500)
        await page.click('input[type="submit"][value="Search"]')
        await page.waitForLoadState('networkidle')

        const selectExists = await page.$('select#resultsPerPage')
        if (selectExists) {
            await page.selectOption('select#resultsPerPage', '100')
            await page.click('input[type="submit"][value="Go"]')
            await page.waitForLoadState('networkidle')
        }

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
        console.error(`Scrape error for ${postcode}:`, err)
        return []
    }
}

export async function GET(request: Request) {
    try {
        const url = new URL(request.url)
        const days = parseInt(url.searchParams.get('days') ?? '7')
        const postcodes = (url.searchParams.get('postcodes') ?? 'CB1,CB2,CB3,CB4,CB5').split(',')

        const today = new Date()
        const fromDate = new Date(today)
        fromDate.setDate(today.getDate() - days)

        let allApplications: ScrapedApplication[] = []

        for (const postcode of postcodes) {
            console.log(`Scraping ${postcode}...`)
            const results = await scrapePostcode(postcode.trim(), fromDate, today)
            console.log(`${postcode}: ${results.length} results`)
            allApplications = allApplications.concat(results)
        }

        // Deduplicate by ref
        const seen = new Set()
        const unique = allApplications.filter(app => {
            if (seen.has(app.ref)) return false
            seen.add(app.ref)
            return true
        })

        // Store raw data only — no AI summarisation
        let stored = 0
        for (const app of unique) {
            const { error } = await supabase
                .from('applications')
                .upsert({
                    ref: app.ref,
                    address: app.address,
                    proposal: app.proposal,
                    status: app.status,
                    validated: app.validated,
                    link: app.link,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'ref' })

            if (!error) stored++
        }

        return NextResponse.json({
            postcodes,
            days,
            scraped: allApplications.length,
            unique: unique.length,
            stored
        })

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}