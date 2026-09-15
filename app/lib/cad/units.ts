export function cadUnitsToMeters(unitLabel: string) {
  const label = unitLabel.toLowerCase();
  // "мм" and "см" are unit labels saved by earlier Russian versions
  if (label === "mm" || label.includes("мм") || label.includes("millimeter")) return 0.001;
  if (label === "cm" || label.includes("см") || label.includes("centimeter")) return 0.01;
  return 1;
}

/** Unit labels saved by earlier Russian versions of the app, mapped to current labels */
const legacyUnitLabels: Record<string, string> = {
  мм: "mm",
  см: "cm",
  м: "m",
  км: "km",
  футы: "ft",
  дюймы: "in",
  "единицы чертежа": "drawing units",
  "единицы DWG": "DWG units",
};

export function normalizeUnitLabel(label: string) {
  return legacyUnitLabels[label] ?? label;
}
