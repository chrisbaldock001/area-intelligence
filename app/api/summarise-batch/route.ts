import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

export async function GET(request: Request) {
    try {
        const url = new URL(request.url)
        const batchSize = parseInt(url.searchParams.get('batch') ?? '10')
        const autoComplete = url.searchParams.get('auto') === 'true'

        let totalProcessed = 0
        let remaining = 0

        do {
            const { data: applications, error } = await supabase
                .from('applications')
                .select('id, ref, address, proposal, status')
                .or('summary_data.is.null')
                .limit(batchSize)

            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
            if (!applications || applications.length === 0) break

            for (const app of applications) {
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

                            Return ONLY a JSON object with no additional text, markdown, or code blocks:

                            {
                            "proposed": "one sentence describing what is being built, changed or removed",
                            "where": "street name and area in plain terms, no postcode",
                            "impact": "Low or Medium or High",
                            "impact_detail": "one sentence explaining why, focused on effect on daily life"
                            }

                            Reference: ${app.ref}
                            Address: ${app.address}
                            Proposal: ${app.proposal}
                            Status: ${app.status}`
                        }]
                    })
                })

                const data = await response.json()
                const summary = data.content?.[0]?.text ?? ''

                let summaryData = null
                try {
                    summaryData = JSON.parse(summary)
                } catch {
                    // fallback if AI doesn't return valid JSON
                }

                await supabase
                    .from('applications')
                    .update({
                        summary: summaryData ? `${summaryData.proposed} ${summaryData.impact_detail}` : summary,
                        summary_data: summaryData
                    })
                    .eq('id', app.id)

                totalProcessed++
            }

            const { count } = await supabase
                .from('applications')
                .select('id', { count: 'exact' })
                .or('summary_data.is.null')

            remaining = count ?? 0

        } while (autoComplete && remaining > 0)

        return NextResponse.json({ totalProcessed, remaining })

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}