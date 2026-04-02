import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
)

export async function GET() {
    // Get applications without coordinates
    const { data: applications, error } = await supabase
        .from('applications')
        .select('id, address')
        .is('latitude', null)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!applications || applications.length === 0) return NextResponse.json({ message: 'Nothing to geocode' })

    const results = []

    for (const app of applications) {
        const query = encodeURIComponent(`${app.address}, UK`)
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}&limit=1`

        const res = await fetch(url)
        const data = await res.json()

        const coords = data.features?.[0]?.geometry?.coordinates

        if (coords) {
            const { error: updateError } = await supabase
                .from('applications')
                .update({ longitude: coords[0], latitude: coords[1] })
                .eq('id', app.id)

            results.push({ address: app.address, longitude: coords[0], latitude: coords[1], success: !updateError })
        } else {
            results.push({ address: app.address, success: false })
        }
    }

    return NextResponse.json({ geocoded: results.length, results })
}