// Kinds of special aircraft and what the screens call them.
export const SPECIAL_LABELS = {
  police: 'Police',
  ambulance: 'Air ambulance',
  firefighting: 'Firefighting',
  rescue: 'Search & rescue',
  military: 'Military',
  government: 'Government',
  other: 'Special',
};

export const SPECIAL_KINDS = Object.keys(SPECIAL_LABELS);

/** Emergency squawk codes and what they mean. */
export const EMERGENCY_SQUAWKS = { 7500: 'hijack', 7600: 'radio failure', 7700: 'emergency' };
