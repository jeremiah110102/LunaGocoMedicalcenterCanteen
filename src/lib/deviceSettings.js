// Settings that belong to this device (printer, scanner), saved in the browser.
const KEY = 'canteen.device';
export const DEVICE_DEFAULTS = {
  paperWidth: 80, // 58 or 80 mm thermal paper
  autoPrint: false, // print the receipt right after each sale
  kitchenSlip: false, // also print a kitchen order slip
  largeText: false,
  scanSound: true, // beep when a scanned item is added
};

export function getDeviceSettings() {
  try {
    return { ...DEVICE_DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) };
  } catch {
    return { ...DEVICE_DEFAULTS };
  }
}

export function saveDeviceSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...getDeviceSettings(), ...s }));
  } catch {
    /* storage unavailable */
  }
}
