// src/routines/interpolate.ts

/**
 * Interpolate {{VAR_NAME}} placeholders with process.env values.
 * Unknown variables are left as-is and a warning is emitted.
 */
export function interpolate(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = process.env[key];
    if (val === undefined) {
      console.warn(`[scheduler] Unknown template variable: {{${key}}}`);
      return `{{${key}}}`;
    }
    return val;
  });
}
