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
                .or('summary.is.null,summary.eq.')
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

                await supabase
                    .from('applications')
                    .update({ summary })
                    .eq('id', app.id)

                totalProcessed++
            }

            const { count } = await supabase
                .from('applications')
                .select('id', { count: 'exact' })
                .or('summary.is.null,summary.eq.')

            remaining = count ?? 0

        } while (autoComplete && remaining > 0)

        return NextResponse.json({ totalProcessed, remaining })

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}