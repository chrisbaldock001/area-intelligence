import { NextResponse } from 'next/server'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

export async function GET(request: Request) {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    try {
        const url = new URL(request.url)
        const days = parseInt(url.searchParams.get('days') ?? '7')
        const today = new Date()
        const from = new Date(today)
        from.setDate(today.getDate() - days)
        const fmt = (d: Date) => d.toLocaleDateString('en-GB')

        // Step 1: Scrape applications
        await page.goto('https://applications.greatercambridgeplanning.org/online-applications/search.do?action=advanced')
        await page.waitForLoadState('networkidle')
        await page.waitForSelector('input[type="submit"][value="Search"]', { timeout: 10000 })
        await page.fill('input[name="date(applicationValidatedStart)"]', fmt(from))
        await page.fill('input[name="date(applicationValidatedEnd)"]', fmt(today))
        await page.waitForTimeout(500)
        await page.click('input[type="submit"][value="Search"]')
        await page.waitForLoadState('networkidle')
        await page.waitForSelector('li.searchresult', { timeout: 30000 })

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

        // Step 2: Summarise and store each application
        const results = []

        for (const app of applications) {
            // Generate AI summary
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

            // Store in Supabase
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

        await browser.close()
        return NextResponse.json({ count: results.length, results })

    } catch (err) {
        await browser.close()
        const message = err instanceof Error ? err.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}