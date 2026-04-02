import { NextResponse } from 'next/server'

export async function GET() {
    const application = {
        ref: '26/0328/TTPO',
        address: '59-61 High Street Harston Cambridgeshire CB22 7PZ',
        proposal: 'Tree work to provide vehicular and pedestrian clearance to parking area for new bakery/cafe. T6 YEW x 15ms high - reduce low canopy back by 2.5ms to boundary fence line up to 3.5 to 4ms height and then trim back higher branches up to 1m. T9 YEW x 12ms high - reduce low canopy back by 2.5ms to boundary fence line up to 3.5 to 4ms height and then trim back higher branches up to 1m.',
        status: 'Awaiting decision',
        validated: 'Mon 30 Mar 2026'
    }

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

Reference: ${application.ref}
Address: ${application.address}
Proposal: ${application.proposal}
Status: ${application.status}`
            }]
        })
    })

    const data = await response.json()
    console.log('Anthropic response:', JSON.stringify(data))
    const summary = data.content?.[0]?.text ?? 'No summary generated'
    return NextResponse.json({ application, summary })
}
