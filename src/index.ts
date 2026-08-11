const ALPHION_ASSETS = Object.freeze({
  primary: "alphion-logo.svg",
  icon: "alphion-icon.svg",
  wordmark: "alphion-wordmark.svg",
} as const);

/** Stable product identity shared by future Alphion adapters and surfaces. */
export const ALPHION_BRAND = Object.freeze({
  name: "Alphion",
  tagline:
    "A lightweight, project-aware agent harness that evolves through evidence and control.",
  assets: ALPHION_ASSETS,
} as const);

export type AlphionBrand = typeof ALPHION_BRAND;
