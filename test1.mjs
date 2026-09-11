import { parseBulkText } from './src/lib/drugChartHelpers.js';
const text = "IVF normal saline 500mls fast over 30 mins then 500ml over 1 hr, then 500mls 4hrly";
console.log(JSON.stringify(parseBulkText(text), null, 2));
