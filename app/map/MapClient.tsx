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

export default function MapPage() {
    const mapContainer = useRef<HTMLDivElement>(null)
    const map = useRef<mapboxgl.Map | null>(null)
    const [selectedApp, setSelectedApp] = useState<Application | null>(null)
    const [radiusKm, setRadiusKm] = useState(0.5)
    const [radiusCentre, setRadiusCentre] = useState<[number, number] | null>(null)
    const isDragging = useRef(false)
    const radiusCentreRef = useRef<[number, number] | null>(null)
    const dragHandlersAdded = useRef(false)
    const handleMarkerRef = useRef<mapboxgl.Marker | null>(null)
    const radiusKmRef = useRef(0.5)
    const [areaSummary, setAreaSummary] = useState<string | null>(null)
    const [areaSummaryLoading, setAreaSummaryLoading] = useState(false)
    const [showRadiusLabel, setShowRadiusLabel] = useState(false)
    const radiusLabelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [viewportHeight, setViewportHeight] = useState('100dvh')

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

        // Add drag handle marker at top of circle
        const northPoint: [number, number] = [newCentre[0], newCentre[1] + radiusKm / 110.574]

        const handleEl = document.createElement('div')
        handleEl.style.width = '44px'
        handleEl.style.height = '44px'
        handleEl.style.borderRadius = '50%'
        handleEl.style.backgroundColor = '#3B6FE0'
        handleEl.style.border = '2px solid white'
        handleEl.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)'
        handleEl.style.cursor = 'grab'

        const handleMarker = new mapboxgl.Marker({ element: handleEl })
            .setLngLat(northPoint)
            .addTo(map.current!)

        handleMarkerRef.current = handleMarker

        handleEl.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            isDragging.current = true
            map.current!.dragPan.disable()
        })

        handleEl.addEventListener('touchstart', (e) => {
            e.preventDefault()
            e.stopPropagation()
            isDragging.current = true
            map.current!.dragPan.disable()
        }, { passive: false })

        if (!dragHandlersAdded.current) {
            dragHandlersAdded.current = true

            map.current.on('mousedown', 'radius-circle-border', (e) => {
                e.preventDefault()
                isDragging.current = true
                map.current!.dragPan.disable()
            })

            map.current.on('mousemove', (e) => {
                if (!isDragging.current || !radiusCentreRef.current) return
                const c = new mapboxgl.LngLat(radiusCentreRef.current[0], radiusCentreRef.current[1])
                const newRadius = c.distanceTo(e.lngLat) / 1000
                radiusKmRef.current = newRadius
                setRadiusKm(newRadius)
                showRadiusLabelBriefly()
                const updated = createGeoJSONCircle(radiusCentreRef.current, newRadius)
                const source = map.current!.getSource('radius-circle') as mapboxgl.GeoJSONSource
                if (source) source.setData(updated)
                if (handleMarkerRef.current) {
                    const north: [number, number] = [
                        radiusCentreRef.current[0],
                        radiusCentreRef.current[1] + newRadius / 110.574
                    ]
                    handleMarkerRef.current.setLngLat(north)
                }
            })

            map.current.on('mouseup', () => {
                isDragging.current = false
                map.current!.dragPan.enable()
            })

            map.current.getCanvas().addEventListener('touchmove', (e) => {
                if (!isDragging.current || !radiusCentreRef.current) return
                e.preventDefault()
                const touch = e.touches[0]
                const rect = map.current!.getCanvas().getBoundingClientRect()
                const point = new mapboxgl.Point(
                    touch.clientX - rect.left,
                    touch.clientY - rect.top
                )
                const lngLat = map.current!.unproject(point)
                const c = new mapboxgl.LngLat(radiusCentreRef.current[0], radiusCentreRef.current[1])
                const newRadius = c.distanceTo(lngLat) / 1000
                radiusKmRef.current = newRadius
                setRadiusKm(newRadius)
                showRadiusLabelBriefly()
                const updated = createGeoJSONCircle(radiusCentreRef.current, newRadius)
                const source = map.current!.getSource('radius-circle') as mapboxgl.GeoJSONSource
                if (source) source.setData(updated)
                if (handleMarkerRef.current) {
                    const north: [number, number] = [
                        radiusCentreRef.current[0],
                        radiusCentreRef.current[1] + newRadius / 110.574
                    ]
                    handleMarkerRef.current.setLngLat(north)
                }
            }, { passive: false })

            map.current.getCanvas().addEventListener('touchend', () => {
                isDragging.current = false
                map.current!.dragPan.enable()
            })

            // Touch support for mobile
            handleEl.addEventListener('touchstart', (e) => {
                e.preventDefault()
                e.stopPropagation()
                isDragging.current = true
                map.current!.dragPan.disable()
            }, { passive: false })

            map.current.getCanvas().addEventListener('touchmove', (e) => {
                if (!isDragging.current || !radiusCentreRef.current) return
                e.preventDefault()
                const touch = e.touches[0]
                const rect = map.current!.getCanvas().getBoundingClientRect()
                const point = new mapboxgl.Point(
                    touch.clientX - rect.left,
                    touch.clientY - rect.top
                )
                const lngLat = map.current!.unproject(point)
                const c = new mapboxgl.LngLat(radiusCentreRef.current[0], radiusCentreRef.current[1])
                const newRadius = c.distanceTo(lngLat) / 1000
                radiusKmRef.current = newRadius
                setRadiusKm(newRadius)
                showRadiusLabelBriefly()
                const updated = createGeoJSONCircle(radiusCentreRef.current, newRadius)
                const source = map.current!.getSource('radius-circle') as mapboxgl.GeoJSONSource
                if (source) source.setData(updated)
                if (handleMarkerRef.current) {
                    const north: [number, number] = [
                        radiusCentreRef.current[0],
                        radiusCentreRef.current[1] + newRadius / 110.574
                    ]
                    handleMarkerRef.current.setLngLat(north)
                }
            }, { passive: false })

            map.current.getCanvas().addEventListener('touchend', () => {
                isDragging.current = false
                map.current!.dragPan.enable()
            })

        }
    }

    const handleAreaSummary = async () => {
        if (!radiusCentreRef.current) return
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

            const { data, error } = await supabase
                .from('applications')
                .select('*')
                .not('latitude', 'is', null)

            console.log('data:', data, 'error:', error)

            if (!data || data.length === 0) return

            data.forEach((app: Application) => {
                const el = document.createElement('div')
                el.style.width = '20px'
                el.style.height = '20px'
                el.style.borderRadius = '50%'
                el.style.backgroundColor = '#1a1a1a'
                el.style.cursor = 'pointer'
                el.style.border = '2px solid white'
                el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)'

                new mapboxgl.Marker({ element: el })
                    .setLngLat([app.longitude, app.latitude])
                    .addTo(map.current!)

                el.addEventListener('click', () => setSelectedApp(app))
            })

            const bounds = new mapboxgl.LngLatBounds()
            data.forEach((app: Application) => bounds.extend([app.longitude, app.latitude]))
            map.current!.fitBounds(bounds, { padding: 80, maxZoom: 13 })
        }

        map.current.on('load', addPins)

        return () => window.removeEventListener('resize', updateHeight)
    }, [])

    return (
        <div style={{
            width: '100vw',
            height: viewportHeight,
            position: 'relative',
            paddingTop: 'env(safe-area-inset-top)'
        }}>

            {/* Search bar */}
            <div style={{ position: 'absolute', top: 'calc(16px + env(safe-area-inset-top))', left: 16, zIndex: 10 }}>
                <div style={{
                    background: 'white', borderRadius: 12, padding: '12px 16px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)', display: 'flex',
                    alignItems: 'center', gap: 8, width: '300px'
                }}>
                    <SearchIcon style={{ color: '#2D2D2D' }} />
                    <input
                        placeholder="Search an address..."
                        style={{ border: 'none', outline: 'none', fontSize: 16, width: '100%', color: '#2D2D2D' }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSearch((e.target as HTMLInputElement).value)
                        }}
                    />
                </div>
            </div>

            {/* Radius label */}
            <div suppressHydrationWarning style={{
                position: 'absolute', top: 16, right: 16, zIndex: 10,
                opacity: showRadiusLabel ? 1 : 0,
                transition: 'opacity 300ms ease',
                pointerEvents: 'none'
            }}>
                <div style={{
                    background: 'white', borderRadius: 12, padding: '12px 20px',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)', textAlign: 'center',
                    border: '2px solid #3B6FE0'
                }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#3B6FE0' }}>Search Radius:</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color: '#3B6FE0' }}>{(radiusKm * 1000).toFixed(0)}m</div>
                </div>
            </div>

            {/* Map */}
            <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

            {/* Application summary card */}
            {selectedApp && (
                <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
                    background: 'white', borderRadius: '16px 16px 0 0',
                    padding: 24, maxHeight: '50vh', overflowY: 'auto',
                    boxShadow: '0 -2px 12px rgba(0,0,0,0.15)'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                        <strong style={{ fontSize: 18, color: '#2D2D2D' }}>Planning Application</strong>
                        <button onClick={() => setSelectedApp(null)}
                            style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#2D2D2D' }}>✕</button>
                    </div>
                    <p style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>{selectedApp.ref} · {selectedApp.address}</p>
                    <p style={{ fontSize: 15, lineHeight: 1.6, color: '#2D2D2D' }}>{stripMarkdown(selectedApp.summary)}</p>
                </div>
            )}

            {/* Area summary button */}
            {radiusCentre && (
                <div style={{
                    position: 'absolute', bottom: 80, left: 16, zIndex: 10
                }}>
                    <button
                        onClick={handleAreaSummary}
                        style={{
                            width: 48, height: 48, borderRadius: '50%',
                            background: 'white', border: 'none', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
                        }}
                    >
                        <SummarizeOutlinedIcon style={{ color: '#2D2D2D' }} />
                    </button>
                </div>

            )}


            {/* Area summary card */}
            {(areaSummary || areaSummaryLoading) && (
                <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
                    background: 'white', borderRadius: '16px 16px 0 0',
                    padding: 24, maxHeight: '50vh', overflowY: 'auto',
                    boxShadow: '0 -2px 12px rgba(0,0,0,0.15)'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                        <strong style={{ fontSize: 18, color: '#2D2D2D' }}>Area Summary</strong>
                        <button onClick={() => setAreaSummary(null)}
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
