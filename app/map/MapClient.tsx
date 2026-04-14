'use client'

import SearchIcon from '@mui/icons-material/Search'
import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { supabase } from '../../lib/supabase'
import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''

interface Application {
    id: string
    ref: string
    address: string
    proposal: string
    status: string
    summary: string
    latitude: number
    longitude: number
}

function stripMarkdown(text: string): string {
    let clean = text
    clean = clean.replace(/#{1,6}\s+/g, '')
    clean = clean.replace(/\*\*([^*]+)\*\*/g, '$1')
    clean = clean.replace(/\*([^*]+)\*/g, '$1')
    clean = clean.trim()
    return clean
}

function createGeoJSONCircle(centre: [number, number], radiusKm: number, points = 64) {
    const coords = { lat: centre[1], lng: centre[0] }
    const ret = []
    const distanceX = radiusKm / (111.32 * Math.cos((coords.lat * Math.PI) / 180))
    const distanceY = radiusKm / 110.574

    for (let i = 0; i < points; i++) {
        const theta = (i / points) * (2 * Math.PI)
        const x = distanceX * Math.cos(theta)
        const y = distanceY * Math.sin(theta)
        ret.push([coords.lng + x, coords.lat + y])
    }
    ret.push(ret[0])

    return {
        type: 'Feature' as const,
        geometry: { type: 'Polygon' as const, coordinates: [ret] },
        properties: {}
    }
}

export default function MapClient() {
    const mapContainer = useRef<HTMLDivElement>(null)
    const map = useRef<mapboxgl.Map | null>(null)
    const [selectedApp, setSelectedApp] = useState<Application | null>(null)
    const [radiusKm, setRadiusKm] = useState(0.5)
    const [radiusCentre, setRadiusCentre] = useState<[number, number] | null>(null)
    const radiusCentreRef = useRef<[number, number] | null>(null)
    const radiusKmRef = useRef(0.5)
    const [areaSummary, setAreaSummary] = useState<string | null>(null)
    const [areaSummaryLoading, setAreaSummaryLoading] = useState(false)
    const [showRadiusLabel, setShowRadiusLabel] = useState(false)
    const radiusLabelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [viewportHeight, setViewportHeight] = useState('100dvh')
    const [searchValue, setSearchValue] = useState('')
    const [mounted, setMounted] = useState(false)
    const [showIntro, setShowIntro] = useState(false)
    const markersRef = useRef<mapboxgl.Marker[]>([])

    const handleSearch = async (query: string) => {
        if (!query.trim() || !map.current) return

        const centre = map.current.getCenter()
        const encoded = encodeURIComponent(query)
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}&limit=1&country=GB&proximity=${centre.lng},${centre.lat}&bbox=-0.3,52.0,0.4,52.4`

        const res = await fetch(url)
        const data = await res.json()

        const coords = data.features?.[0]?.geometry?.coordinates
        if (!coords) return

        const newCentre: [number, number] = [coords[0], coords[1]]

        map.current.flyTo({ center: newCentre, zoom: 14, duration: 1500 })

        setRadiusCentre(newCentre)
        radiusCentreRef.current = newCentre

        const circleData = createGeoJSONCircle(newCentre, radiusKm)

        if (map.current.getSource('radius-circle')) {
            (map.current.getSource('radius-circle') as mapboxgl.GeoJSONSource).setData(circleData)
        } else {
            map.current.addSource('radius-circle', { type: 'geojson', data: circleData })
            map.current.addLayer({
                id: 'radius-circle-fill',
                type: 'fill',
                source: 'radius-circle',
                paint: { 'fill-color': '#3B6FE0', 'fill-opacity': 0.15 }
            })
            map.current.addLayer({
                id: 'radius-circle-border',
                type: 'line',
                source: 'radius-circle',
                paint: { 'line-color': '#3B6FE0', 'line-width': 2 }
            })
        }
    }

    const adjustRadius = (deltaKm: number) => {
        if (!radiusCentreRef.current || !map.current) return
        const newRadius = Math.max(0.1, radiusKm + deltaKm)
        radiusKmRef.current = newRadius
        setRadiusKm(newRadius)
        showRadiusLabelBriefly()
        const updated = createGeoJSONCircle(radiusCentreRef.current, newRadius)
        const source = map.current.getSource('radius-circle') as mapboxgl.GeoJSONSource
        if (source) source.setData(updated)
    }

    const handleAreaSummary = async () => {
        if (!radiusCentreRef.current) return
        setSelectedApp(null)
        setAreaSummaryLoading(true)
        setAreaSummary(null)

        const res = await fetch('/api/area-summary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lat: radiusCentreRef.current[1],
                lng: radiusCentreRef.current[0],
                radiusKm: radiusKmRef.current
            })
        })

        const data = await res.json()
        setAreaSummary(data.summary)
        setAreaSummaryLoading(false)
    }

    const showRadiusLabelBriefly = () => {
        setShowRadiusLabel(true)
        if (radiusLabelTimer.current) clearTimeout(radiusLabelTimer.current)
        radiusLabelTimer.current = setTimeout(() => {
            setShowRadiusLabel(false)
        }, 1500)
    }

    useEffect(() => {
        setShowIntro(true)
        setMounted(true)
        if (map.current || !mapContainer.current) return

        const updateHeight = () => {
            setViewportHeight(`${window.innerHeight}px`)
        }
        updateHeight()
        window.addEventListener('resize', updateHeight)

        map.current = new mapboxgl.Map({
            container: mapContainer.current,
            style: 'mapbox://styles/mapbox/light-v11',
            center: [-0.1218, 52.2053],
            zoom: 13
        })

        map.current.addControl(new mapboxgl.NavigationControl(), 'bottom-right')

        const addPins = async () => {
            if (!map.current) return

            const { data } = await supabase
                .from('applications')
                .select('*')
                .not('latitude', 'is', null)

            if (!data || data.length === 0) return

            data.forEach((app: Application) => {
                try {
                    const el = document.createElement('div')
                    el.style.width = '20px'
                    el.style.height = '20px'
                    el.style.borderRadius = '50%'
                    el.style.backgroundColor = '#1a1a1a'
                    el.style.cursor = 'pointer'
                    el.style.border = '2px solid white'
                    el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)'
                    el.style.display = 'none'

                    const marker = new mapboxgl.Marker({ element: el })
                        .setLngLat([app.longitude, app.latitude])
                        .addTo(map.current!)

                    markersRef.current.push(marker)

                    el.addEventListener('click', (e) => {
                        e.stopPropagation()
                        setAreaSummary(null)
                        setSelectedApp(app)
                    })
                } catch (err) {
                    console.warn('Marker error:', err)
                }
            })

            const bounds = new mapboxgl.LngLatBounds()
            data.forEach((app: Application) => bounds.extend([app.longitude, app.latitude]))
            map.current!.fitBounds(bounds, { padding: 80, maxZoom: 13 })
        }

        map.current.on('load', addPins)

        return () => {
            window.removeEventListener('resize', updateHeight)
            markersRef.current.forEach(m => m.remove())
        }
    }, [])

    // Show pins only after search
    useEffect(() => {
        if (!map.current) return
        const markers = document.querySelectorAll('.mapboxgl-marker')
        markers.forEach((marker) => {
            (marker as HTMLElement).style.display = radiusCentre ? 'block' : 'none'
        })
    }, [radiusCentre])

    const cardVisible = selectedApp !== null
    const summaryVisible = areaSummary !== null || areaSummaryLoading

    return (
        <div style={{
            width: '100vw',
            height: viewportHeight,
            position: 'relative',
            paddingTop: 'env(safe-area-inset-top)'
        }}>

            {/* Intro screen */}
            {mounted && showIntro && (
                <div style={{
                    position: 'absolute', inset: 0, zIndex: 20,
                    background: 'rgba(0,0,0,0.6)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 24
                }}>
                    <div style={{
                        background: 'white', borderRadius: 20, padding: 32,
                        maxWidth: 360, width: '100%', textAlign: 'center'
                    }}>
                        <div style={{ fontSize: 32, marginBottom: 16 }}>📍</div>
                        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#2D2D2D', marginBottom: 12 }}>
                            Area Intelligence
                        </h2>
                        <p style={{ fontSize: 15, lineHeight: 1.6, color: '#555', marginBottom: 24 }}>
                            Search your street to discover what's being planned in your area — in plain English.
                        </p>
                        <button
                            onClick={() => setShowIntro(false)}
                            style={{
                                background: '#3B6FE0', color: 'white', border: 'none',
                                borderRadius: 24, padding: '14px 32px', fontSize: 16,
                                fontWeight: 600, cursor: 'pointer', width: '100%'
                            }}
                        >
                            Get started
                        </button>
                    </div>
                </div>
            )}

            {/* Top bar */}
            <div style={{
                position: 'absolute', top: 'calc(16px + env(safe-area-inset-top))',
                left: 16, right: 16, zIndex: 10,
                display: 'flex', gap: 8, alignItems: 'center'
            }}>
                <div style={{
                    flex: 1, background: 'white', borderRadius: 12, padding: '12px 16px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)', display: 'flex',
                    alignItems: 'center', gap: 8
                }}>
                    <SearchIcon style={{ color: '#2D2D2D' }} />
                    <input
                        placeholder="Search an address..."
                        value={searchValue}
                        onChange={(e) => setSearchValue(e.target.value)}
                        style={{ border: 'none', outline: 'none', fontSize: 16, width: '100%', color: '#2D2D2D' }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                handleSearch(searchValue);
                                (e.target as HTMLInputElement).blur()
                            }
                        }}
                    />
                    {searchValue && (
                        <button
                            onClick={() => {
                                setSearchValue('')
                                setRadiusCentre(null)
                                setAreaSummary(null)
                                setSelectedApp(null)
                                if (map.current?.getSource('radius-circle')) {
                                    (map.current.getSource('radius-circle') as mapboxgl.GeoJSONSource).setData({
                                        type: 'FeatureCollection',
                                        features: []
                                    })
                                }
                            }}
                            style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: '#999', fontSize: 18, padding: 0, lineHeight: 1
                            }}
                        >✕</button>
                    )}
                </div>
            </div>

            {/* Overlay */}
            {mounted && (cardVisible || summaryVisible) && (
                <div
                    onClick={() => {
                        setSelectedApp(null)
                        setAreaSummary(null)
                        setAreaSummaryLoading(false)
                    }}
                    style={{
                        position: 'absolute', inset: 0, zIndex: 9,
                        background: 'rgba(0,0,0,0.2)'
                    }}
                />
            )}

            {/* Map */}
            <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

            {/* Application summary card */}
            {mounted && (
                <div suppressHydrationWarning style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    zIndex: 11,
                    background: 'white', borderRadius: '16px 16px 0 0',
                    padding: 24, maxHeight: '50vh', overflowY: 'auto',
                    boxShadow: '0 -2px 12px rgba(0,0,0,0.15)',
                    transform: cardVisible ? 'translateY(0)' : 'translateY(100%)',
                    pointerEvents: cardVisible ? 'auto' : 'none'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                        <strong style={{ fontSize: 18, color: '#2D2D2D' }}>Planning Application</strong>
                        <button onClick={() => setSelectedApp(null)}
                            style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#2D2D2D' }}>✕</button>
                    </div>
                    <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>{selectedApp?.ref} · {selectedApp?.address}</p>
                    <p style={{ fontSize: 15, lineHeight: 1.6, color: '#2D2D2D' }}>{stripMarkdown(selectedApp?.summary ?? '')}</p>
                </div>
            )}

            {/* Bottom bar */}
            {radiusCentre && (
                <div style={{
                    position: 'absolute', bottom: 32, left: '50%',
                    transform: 'translateX(-50%)', zIndex: 10,
                    display: 'flex', alignItems: 'flex-end', gap: 12
                }}>
                    <button
                        onClick={handleAreaSummary}
                        style={{
                            background: '#3B6FE0', border: 'none', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '12px 20px', borderRadius: 24, height: 48,
                            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                            fontSize: 15, fontWeight: 600, color: 'white'
                        }}
                    >
                        <SummarizeOutlinedIcon style={{ color: 'white', fontSize: 20 }} />
                        Summarise
                    </button>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div suppressHydrationWarning style={{
                            background: 'white', borderRadius: 8, padding: '4px 10px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.15)', textAlign: 'center',
                            border: '1.5px solid #3B6FE0',
                            opacity: showRadiusLabel ? 1 : 0,
                            transition: 'opacity 300ms ease',
                            pointerEvents: 'none'
                        }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#3B6FE0' }}>{(radiusKm * 1000).toFixed(0)}m</div>
                        </div>
                        <div style={{
                            background: '#3B6FE0', borderRadius: 24, padding: '12px 16px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.2)', display: 'flex',
                            alignItems: 'center', gap: 8, height: 48, boxSizing: 'border-box' as const
                        }}>
                            <button onClick={() => adjustRadius(-0.1)} style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                fontSize: 20, fontWeight: 700, color: 'white',
                                padding: '0 4px', lineHeight: 1
                            }}>−</button>
                            <span style={{ fontSize: 14, fontWeight: 600, color: 'white' }}>Radius</span>
                            <button onClick={() => adjustRadius(0.1)} style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                fontSize: 20, fontWeight: 700, color: 'white',
                                padding: '0 4px', lineHeight: 1
                            }}>+</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Area summary card */}
            {mounted && (
                <div suppressHydrationWarning style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    zIndex: summaryVisible ? 11 : -1,
                    background: 'white', borderRadius: '16px 16px 0 0',
                    padding: 24, maxHeight: '50vh', overflowY: 'auto',
                    boxShadow: '0 -2px 12px rgba(0,0,0,0.15)',
                    transform: summaryVisible ? 'translateY(0)' : 'translateY(100%)',
                    transition: 'transform 300ms ease'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                        <strong style={{ fontSize: 18, color: '#2D2D2D' }}>Area Summary</strong>
                        <button onClick={() => { setAreaSummary(null); setAreaSummaryLoading(false) }}
                            style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#2D2D2D' }}>✕</button>
                    </div>
                    {areaSummaryLoading
                        ? <p style={{ color: '#666', fontSize: 15 }}>Analysing your area...</p>
                        : <p style={{ fontSize: 15, lineHeight: 1.6, color: '#2D2D2D', whiteSpace: 'pre-wrap' }}>{stripMarkdown(areaSummary ?? '')}</p>}
                </div>
            )}

        </div>
    )
}