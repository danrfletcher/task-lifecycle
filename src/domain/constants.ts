/**
 * Fixed timings and stamp emoji.
 *
 * These are plain constants on purpose: there is no setter and no settings
 * key, and no function in the plugin accepts a replacement from outside.
 */

/** Press-and-hold time before a checkbox is cancelled. */
export const LONG_PRESS_MS = 500;

/** Pointer movement (px) beyond which a press is no longer a press. */
export const MOVE_TOLERANCE_PX = 5;

/** How long the click that follows a long press is swallowed. */
export const CLICK_SWALLOW_MS = 600;

/** Per-line window in which the plugin ignores changes it wrote itself. */
export const SELF_WRITE_SUPPRESSION_MS = 1200;

/** Per file+line window in which a second cascade prompt is suppressed. */
export const CASCADE_DEDUPE_MS = 1500;

/** Stamp emoji for a done task. */
export const DONE_EMOJI = "✅";

/** Stamp emoji for a cancelled task. */
export const CANCELLED_EMOJI = "❌";
