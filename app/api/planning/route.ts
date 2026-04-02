import { NextResponse } from 'next/server'
import { chromium } from 'playwright'

export async function GET() {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    try {
        const today = new Date()
        const week = new Date(today)
        week.setDate(today.getDate() - 7)
        const fmt = (d: Date) => d.toLocaleDateString('en-GB')

        // Step 1: Search for applications
        await page.goto('https://applications.greatercambridgeplanning.org/online-applications/search.do?action=advanced')
        await page.fill('input[name="date(applicationValidatedStart)"]', fmt(week))
        await page.fill('input[name="date(applicationValidatedEnd)"]', fmt(today))
        await page.click('input[type="submit"][value="Search"]')

        // Wait for results
        await page.waitForSelector('li.searchresult', { timeout: 10000 })

        // Extract results
        const results = await page.evaluate(() => {
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

        // Step 2: Fetch detail for first result
        const firstLink = results[0]?.link
        let detail = {}

        if (firstLink) {
            await page.goto(`https://applications.greatercambridgeplanning.org${firstLink}`)
            await page.waitForLoadState('networkidle')

            detail = await page.evaluate(() => {
                const getVal = (label: string) => {
                    const rows = Array.from(document.querySelectorAll('tr'))
                    const row = rows.find(r => r.querySelector('th')?.textContent?.trim() === label)
                    return row?.querySelector('td')?.textContent?.trim() ?? ''
                }
                return {
                    reference: getVal('Reference'),
                    proposal: getVal('Proposal'),
                    status: getVal('Status'),
                    received: getVal('Application Received'),
                    validated: getVal('Application Validated'),
                    address: getVal('Address'),
                }
            })
        }

        await browser.close()
        return NextResponse.json({ count: results.length, results, detail })

    } catch (err) {
        await browser.close()
        const message = err instanceof Error ? err.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}