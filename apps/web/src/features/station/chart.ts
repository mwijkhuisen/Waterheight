// The lazy chart chunk (A§10: ECharts is never in the initial bundle). Only the
// parts the panel uses are registered. The tooltip is drawn on the canvas
// (`renderMode: 'richText'`) and its formatter returns plain text, so a station
// name is never parsed as HTML (invariant 3).
import { LineChart } from 'echarts/charts';
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { testHook } from '../../lib/testHook.ts';
import { formatLocal, formatShort } from '../../lib/time/time.ts';
import type { Locale } from '../../paraglide/runtime.js';

use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);

export interface ChartData {
  locale: Locale;
  /** The station name exactly as published: untrusted text. */
  name: string;
  /** The unit as published, with its zero ("cm NAP"). */
  unit: string;
  /** [UTC ms, value in the native unit]. */
  points: [number, number][];
  /** The selected instant, marked by a vertical line. */
  t: number;
  format: (value: number) => string;
}

interface AxisParam {
  value?: unknown;
}

export function createChart(el: HTMLElement) {
  const chart = init(el, undefined, { renderer: 'canvas' });
  const resize = new ResizeObserver(() => chart.resize());
  resize.observe(el);
  testHook?.charts?.add(chart);
  return {
    update(d: ChartData) {
      const tip = (params: AxisParam | AxisParam[]): string => {
        const value = (Array.isArray(params) ? params[0] : params)?.value;
        if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'number') return '';
        return `${d.name}\n${formatLocal(value[0], d.locale)}\n${d.format(value[1])} ${d.unit}`;
      };
      chart.setOption(
        {
          animation: false,
          grid: { left: 56, right: 16, top: 24, bottom: 32 },
          xAxis: { type: 'time', axisLabel: { formatter: (v: number) => formatShort(v, d.locale), hideOverlap: true } },
          yAxis: { type: 'value', scale: true, name: d.unit, nameTextStyle: { align: 'left' } },
          tooltip: { trigger: 'axis', renderMode: 'richText', formatter: tip },
          series: [
            {
              type: 'line',
              name: d.name,
              showSymbol: false,
              data: d.points,
              lineStyle: { color: '#01665e' },
              itemStyle: { color: '#01665e' },
              markLine: { silent: true, symbol: 'none', label: { show: false }, data: [{ xAxis: d.t }] },
            },
          ],
        },
        { notMerge: true },
      );
    },
    dispose() {
      resize.disconnect();
      testHook?.charts?.delete(chart);
      chart.dispose();
    },
  };
}
