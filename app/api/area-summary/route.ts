import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

export async function POST(request: Request) {
    const { lat, lng, radiusKm } = await request.json()

    // Fetch all applications with coordinates
    const { data: applications, error } = await supabase
        .from('applications')
        .select('*')
        .not('latitude', 'is', null)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!applications) return NextResponse.json({ error: 'No data' }, { status: 500 })

    // Filter by radius
    const R = 6371 // Earth radius km
    const nearby = applications.filter(app => {
        const dLat = (app.latitude - lat) * Math.PI / 180
        const dLng = (app.longitude - lng) * Math.PI / 180
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat * Math.PI / 180) * Math.cos(app.latitude * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2)
        const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        return d <= radiusKm
    })

    if (nearby.length === 0) {
        return NextResponse.json({ summary: 'No planning applications found in this area.', count: 0 })
    }

    // Build context for AI
    const appList = nearby.map(a => `- ${a.ref}: ${a.address} — ${a.proposal} (${a.status})`).join('\n')

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-opus-4-5',
            max_tokens: 500,
            messages: [{
                role: 'user',
                content: `You are helping local residents understand what is changing in their area.

Based on the following planning applications within ${(radiusKm * 1000).toFixed(0)}m of a location, write a plain English area summary with these sections:
- Active applications in radius: [number]
- What matters the most: [the single most significant application and why]
- Construction timeline: [any known disruption dates or expected works]
- Types of change: [brief breakdown e.g. 3 residential, 2 tree works]
- Awaiting decision: [list applications not yet decided]

Keep it concise and human. No jargon. No markdown. No initial title of 'Area Summary'.

Applications:
${appList}`
            }]
        })
    })

    const data = await response.json()
    const summary = data.content?.[0]?.text ?? 'Unable to generate summary.'

    return NextResponse.json({ summary, count: nearby.length })
}