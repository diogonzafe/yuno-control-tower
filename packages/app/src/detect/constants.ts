// Values are locked by DD11/DD14; changing them requires a flight log.
export const MIN_VOLUME = 30;
// DD11's z, and the value a *single* test needs. The detector tests the whole
// cube in one window, so it derives its own from the count (family-wise.ts);
// familyWiseZ(1) reproduces this exactly, which is why DD11 is refined rather
// than contradicted. Everything off the detection path keeps this constant.
export const Z = 1.96;
export const DELTA_PP_DEFAULT = 3.0;
export const PERSISTENCE_WINDOWS = 3;
export const THIN_CELL_WINDOW_MIN = 5;
export const ONSET_LOOKBACK_MIN = 120;
export const TEMPORAL_LOOKBACK_MIN = 360;
