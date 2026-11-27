import { createTheme } from '@mantine/core';
import type { MantineColorsTuple } from '@mantine/core';

// تدرّج teal معدَّل ليحقق التباين: نص أبيض على الدرجة 6 بتباين ≥ 5:1، والنص الملوّن على فاتح ≥ 4.5:1.
// A teal scale tuned for contrast: white text on shade 6 is ≥ 5:1, and coloured text on light is ≥ 4.5:1.
const teal: MantineColorsTuple = [
  '#e6fcf5',
  '#c3fae8',
  '#96f2d7',
  '#63e6be',
  '#38d9a9',
  '#12b886',
  '#087f5b',
  '#066f51',
  '#056046',
  '#04503a',
];

export const theme = createTheme({
  primaryColor: 'teal',
  colors: { teal },
  primaryShade: 6,
  autoContrast: true,
  luminanceThreshold: 0.179,
  fontFamily: "'Noto Sans Arabic Variable', system-ui, sans-serif",
});
