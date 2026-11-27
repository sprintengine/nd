import type { LatLng } from "../schema/columns.ts";

/** Size of the grid cell a charger's public pin is snapped to, in metres. */
export const APPROXIMATE_LOCATION_CELL_M = 150;

/** Metres per degree of latitude (and of longitude at the equator). */
const METRES_PER_DEGREE = 111_320;

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Snaps a point to the centre of a fixed grid cell about `cellM` metres
 * across, so a public pin is never the exact location. The grid is fixed, so
 * repeated searches always return the same pin and cannot be averaged out.
 */
export function approximateLocation(
  { lat, lng }: LatLng,
  cellM: number = APPROXIMATE_LOCATION_CELL_M,
): LatLng {
  if (!Number.isFinite(cellM) || cellM <= 0) {
    throw new RangeError(`cellM must be a positive number, got ${String(cellM)}`);
  }
  const latStep = cellM / METRES_PER_DEGREE;
  const snappedLat = Math.round(lat / latStep) * latStep;
  // The longitude step depends only on the snapped latitude, never the exact one.
  const lngStep = cellM / (METRES_PER_DEGREE * Math.cos((snappedLat * Math.PI) / 180));
  const snappedLng = Math.round(lng / lngStep) * lngStep;
  return { lat: round(snappedLat, 5), lng: round(snappedLng, 5) };
}

/** Rounds a distance so it cannot be used to triangulate an exact location. */
export function approximateDistanceM(distanceM: number): number {
  return Math.max(100, Math.round(distanceM / 100) * 100);
}
