import "maplibre-gl/dist/maplibre-gl.css";

import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

import { Card, PageShell, SearchField, Segmented } from "../components/page/kit";
import { api } from "../lib/api";
import { mapControl } from "../lib/mapControl";
import { navigate } from "../lib/router";
import { useStore } from "../store/useStore";

type Look = "satellite" | "hybrid" | "streets";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const SOURCES = {
  imagery: {
    type: "raster" as const,
    tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
    tileSize: 256,
    maxzoom: 19,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
  labels: {
    type: "raster" as const,
    tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
    tileSize: 256,
    maxzoom: 19,
  },
  streets: {
    type: "raster" as const,
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256,
    maxzoom: 19,
    attribution: "© OpenStreetMap contributors",
  },
};

function styleFor(look: Look) {
  const layers =
    look === "streets"
      ? [{ id: "streets", type: "raster" as const, source: "streets" }]
      : look === "hybrid"
        ? [
            { id: "imagery", type: "raster" as const, source: "imagery" },
            { id: "labels", type: "raster" as const, source: "labels" },
          ]
        : [{ id: "imagery", type: "raster" as const, source: "imagery" }];
  return { version: 8 as const, sources: SOURCES, layers };
}

const PRESETS = [
  { name: "VIT Vellore", lat: 12.9692, lon: 79.1559, zoom: 16.5 },
  { name: "Marina Beach, Chennai", lat: 13.0500, lon: 80.2824, zoom: 15.5 },
  { name: "Taj Mahal", lat: 27.1751, lon: 78.0421, zoom: 17 },
  { name: "Times Square", lat: 40.758, lon: -73.9855, zoom: 17 },
];

export function MapPage() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const [look, setLook] = useState<Look>("hybrid");
  const [status, setStatus] = useState("Loading the map…");
  const [zoom, setZoom] = useState(2);
  const [failed, setFailed] = useState<string | null>(null);
  const city = useStore((s) => s.settings.defaultCity);

  useEffect(() => {
    let disposed = false;
    let map: MapLibreMap | null = null;
    (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (disposed || !container.current) return;
        map = new maplibre.Map({
          container: container.current,
          style: styleFor("hybrid"),
          center: [79.1, 20],
          zoom: 2,
          attributionControl: { compact: true },
          maxPitch: 60,
        });
        map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), "top-right");
        map.addControl(new maplibre.ScaleControl({ unit: "metric" }), "bottom-left");
        map.on("zoom", () => setZoom(Math.round((map!.getZoom() ?? 0) * 10) / 10));
        map.on("load", () => setStatus("Drag to move, scroll or pinch to zoom."));
        map.on("error", (event) => {
          const message = String((event as unknown as { error?: { message?: string } }).error?.message ?? "");
          if (/tile|fetch|network|Failed/i.test(message)) setStatus("Some map tiles couldn't load. Check your connection.");
        });
        mapRef.current = map;
        mapControl.register({
          panBy: (dx, dy) => map!.panBy([dx, dy], { animate: false }),
          getZoom: () => map!.getZoom(),
          setZoom: (z) => map!.setZoom(Math.min(19, Math.max(1, z))),
        });
      } catch (error) {
        if (!disposed) setFailed("The map couldn't start in this browser (it needs WebGL).");
        console.error(error);
      }
    })();
    return () => {
      disposed = true;
      mapControl.register(null);
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => map.setStyle(styleFor(look) as never);
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [look]);

  const flyTo = async (name: string, lat: number, lon: number, zoomLevel = 16) => {
    const map = mapRef.current;
    if (!map) return;
    const maplibre = await import("maplibre-gl");
    markerRef.current?.remove();
    markerRef.current = new maplibre.Marker({ color: "#ff7a59" }).setLngLat([lon, lat]).setPopup(new maplibre.Popup({ offset: 24 }).setText(name)).addTo(map);
    map.flyTo({ center: [lon, lat], zoom: zoomLevel, duration: 3200, essential: true, curve: 1.6 });
    setStatus(`Flying to ${name}…`);
  };

  const search = async (query: string) => {
    try {
      const place = await api.geocode(query);
      const label = [place.name, place.region, place.country].filter(Boolean).join(", ");
      await flyTo(label, place.lat, place.lon, 14);
    } catch {
      useStore.getState().toast(`Couldn't find "${query}".`, "error");
    }
  };

  return (
    <PageShell
      id="map"
      wide
      actions={<SearchField onSubmit={search} placeholder="Fly to a place" label="Place" />}
    >
      <div className="map-layout">
        <div className="map-frame">
          {failed ? <p className="problem">{failed}</p> : <div ref={container} className="map" data-testid="map" />}
          <span className="map-zoom" aria-live="polite">
            zoom {zoom}
          </span>
        </div>
        <div className="map-side">
          <Card title="Layers">
            <Segmented
              label="Map look"
              value={look}
              onChange={setLook}
              options={[
                { value: "satellite", label: "Satellite" },
                { value: "hybrid", label: "With labels" },
                { value: "streets", label: "Streets" },
              ]}
            />
            <p className="muted small">{status}</p>
          </Card>
          <Card title="Fly there">
            <div className="chips vertical">
              {city && (
                <button type="button" className="chip" onClick={() => void search(city)}>
                  My city: {city}
                </button>
              )}
              {PRESETS.map((p) => (
                <button type="button" className="chip" key={p.name} onClick={() => void flyTo(p.name, p.lat, p.lon, p.zoom)}>
                  {p.name}
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => navigate("earth")}>
              Back out to orbit
            </button>
          </Card>
          <p className="muted small">Satellite imagery © Esri, Maxar and Earthstar Geographics. Streets © OpenStreetMap contributors.</p>
        </div>
      </div>
    </PageShell>
  );
}
