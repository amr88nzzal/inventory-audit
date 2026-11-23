// الواجهة العامة لوحدة الشركة التجريبية: لا يستورد غيرها من ملفاتها الداخلية.
// The demo module's public surface: nothing imports its internal files directly.
export { resetDemo, seedDemo } from './service';
export type { DemoDeps, DemoResult } from './service';
