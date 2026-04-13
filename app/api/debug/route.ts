import { NextResponse } from 'next/server'

export async function GET() {
    return NextResponse.json({
        hasAnonKey: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        anonKeyPrefix: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.substring(0, 20) ?? 'missing',
        hasUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    })
}