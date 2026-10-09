// The lazy chart chunk of the "Langs de rivier" panel (P11c, issue #26; A§10: ECharts is never in the initial bundle).
// x is a true km axis (0 at the NL entry, downstream to the right), y the hourly rows (newest at the top), one
// rectangle per station and hour in the map's Δ colour. A station is a column only where it stands: between columns
// the plot is blank, nothing is interpolated, and a stretch without stations is a hatched band saying so. Station
// names, river names and times arrive as finished strings (the panel owns Paraglide) and are only ever drawn on the
// canvas: the tooltip is `richText` with a plain-text formatter, so a name is never parsed as HTML (invariant 3).
import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams } from 'echarts';
import { CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { DH_COLOUR, type DhBin, REACH_NODATA_COLOUR } from '../../legend/palette.ts';
import type { Cell } from './grid.ts';
import type { Column, Gap } from './path.ts';

use([CustomChart, GridComponent, TooltipComponent, CanvasRenderer]);

// ponytail: a cell reaches half the gap to its nearest neighbour (kept short of it, so columns never touch) but at
// most 4 km, and is never thinner than 1.5 px; crowded stretches are not clustered, add that if a path ever has 150+.
const MAX_HALF_KM = 4;
const MIN_PX = 1.5;
const HALF_OF_GAP = 0.45;
const NARROW_PX = 600;
const GRID = { left: 124, right: 16, top: 8, bottom: 70 };
const GRID_NARROW = { left: 96, right: 8, top: 6, bottom: 58 };
/** The y labels: every `step`-th row from the newest, the smallest whole-hour step that gives a label this much room. */
const LABEL_PX = 16;
const STEPS = [1, 2, 3, 6, 12, 24, 48];
/** A cell with no change known (the grey of the map's no-data reaches); the data holds a bin or this. */
const NO_BIN = 9;
const INK = '#0e3a4b';
const PAPER = '#f4f1ea';
/** The stripes of a tidal column (palette.ts REACH_HATCH_COLOURS[0] as hex: zrender's colour parser wants commas). */
const HATCH = 'rgba(60, 80, 100, 0.55)';

export interface HovData {
  columns: readonly Column[];
  gaps: readonly Gap[];
  /** [row][column], rows ascending in time (the last row is drawn at the top). */
  cells: readonly (readonly Cell[])[];
  /** The local-time label of each row. */
  rowLabels: readonly string[];
  /** The label of each column: the station name, with the owner badge text appended on an owner column. */
  colLabels: readonly string[];
  /** The message of each gap band. */
  gapTexts: readonly string[];
  /** The plain-text tooltip of a cell (column index, row index). */
  tip: (column: number, row: number) => string;
}

/** The t line (a row) and the selected station (a column), either may be absent. */
export interface Marks {
  row: number | undefined;
  column: number | undefined;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const box = (params: CustomSeriesRenderItemParams): Box => params.coordSys as unknown as Box;

/** The pixel of a data point: [x, y]. */
const pixel = (api: CustomSeriesRenderItemAPI, x: number, y: number): [number, number] => {
  const [px = 0, py = 0] = api.coord([x, y]);
  return [px, py];
};

export function createHovChart(el: HTMLElement, onCell: (column: number, row: number) => void) {
  const chart = init(el, undefined, { renderer: 'canvas', devicePixelRatio: Math.min(window.devicePixelRatio, 2) });
  // A phone gets tighter margins and smaller labels; crossing the line redraws.
  const narrow = () => el.clientWidth < NARROW_PX;
  let wasNarrow = narrow();
  // ECharts' own label thinning let about 20 of 168 rows overlap in a 150 px plot (W4): the step is ours.
  const stepOf = (rows: number): number => {
    const g = narrow() ? GRID_NARROW : GRID;
    const rowPx = Math.max(el.clientHeight - g.top - g.bottom, 1) / Math.max(rows, 1);
    return STEPS.find((s) => s * rowPx >= LABEL_PX) ?? (STEPS.at(-1) as number);
  };
  let wasStep = 1;
  const resize = new ResizeObserver(() => {
    chart.resize();
    if (data !== undefined && (narrow() !== wasNarrow || stepOf(data.rowLabels.length) !== wasStep)) api.update(data);
  });
  resize.observe(el);
  let data: HovData | undefined;
  let halves: number[] = [];

  const half = (xs: readonly number[], i: number): number => {
    const x = xs[i] ?? 0;
    const near = Math.min(x - (xs[i - 1] ?? Number.NEGATIVE_INFINITY), (xs[i + 1] ?? Number.POSITIVE_INFINITY) - x);
    return Math.min(near * HALF_OF_GAP, MAX_HALF_KM);
  };

  chart.on('click', (p) => {
    const d = p.data;
    if (p.seriesId === 'cells' && Array.isArray(d)) onCell(Number(d[5]), Number(d[1]));
  });

  const cellItem = (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
    const x = Number(api.value(0));
    const row = Number(api.value(1));
    const hw = Number(api.value(2));
    const bin = Number(api.value(3));
    const [cx, cy] = pixel(api, x, row);
    const w = Math.max(pixel(api, x + hw, row)[0] - pixel(api, x - hw, row)[0], MIN_PX);
    const h = (api.size?.([0, 1]) as number[] | undefined)?.[1] ?? 0;
    const fill = bin === NO_BIN ? REACH_NODATA_COLOUR : DH_COLOUR[bin as DhBin];
    // A fresh decal per element: zrender keeps its pattern on the object.
    const decal = {
      symbol: 'rect',
      symbolSize: 1,
      rotation: Math.PI / 4,
      color: HATCH,
      dashArrayX: [1, 0],
      dashArrayY: [2, 4],
      backgroundColor: fill,
    };
    // Half a pixel more than the row: no hairline between rows.
    return {
      type: 'rect',
      shape: { x: cx - w / 2, y: cy - h / 2, width: w, height: h + 0.5 },
      style: Number(api.value(4)) === 1 ? { fill, decal } : { fill },
    };
  };

  const gapItem = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
    const from = pixel(api, Number(api.value(0)), 0)[0];
    const to = pixel(api, Number(api.value(2)), 0)[0];
    const at = box(params);
    const decal = {
      symbol: 'rect',
      symbolSize: 1,
      rotation: Math.PI / 4,
      color: REACH_NODATA_COLOUR,
      dashArrayX: [1, 0],
      dashArrayY: [2, 6],
      backgroundColor: PAPER,
    };
    return {
      type: 'group',
      children: [
        {
          type: 'rect',
          shape: { x: from, y: at.y, width: to - from, height: at.height },
          style: { fill: PAPER, decal },
        },
        {
          type: 'text',
          silent: true,
          style: {
            text: data?.gapTexts[Number(api.value(3))] ?? '',
            x: (from + to) / 2,
            y: at.y + at.height / 2,
            align: 'center',
            verticalAlign: 'middle',
            fill: INK,
            fontWeight: 600,
            width: Math.max(to - from - 16, 0),
            overflow: 'truncate',
            backgroundColor: PAPER,
            padding: [3, 6],
          },
        },
      ],
    };
  };

  const markItem = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
    const at = box(params);
    if (Number(api.value(0)) === 0) {
      const y = pixel(api, 0, Number(api.value(1)))[1];
      return {
        type: 'line',
        silent: true,
        shape: { x1: at.x, y1: y, x2: at.x + at.width, y2: y },
        style: { stroke: INK, lineWidth: 2 },
      };
    }
    const x = Number(api.value(1));
    const hw = Number(api.value(2));
    const from = pixel(api, x - hw, 0)[0];
    const to = pixel(api, x + hw, 0)[0];
    const w = Math.max(to - from, MIN_PX);
    return {
      type: 'rect',
      silent: true,
      shape: { x: (from + to) / 2 - w / 2, y: at.y, width: w, height: at.height },
      style: { fill: 'none', stroke: INK, lineWidth: 2 },
    };
  };

  /** The marker series' data: kind 0 = [0, row], kind 1 = [1, x, half width]. */
  const markData = (m: Marks): number[][] => {
    const c = m.column === undefined ? undefined : data?.columns[m.column];
    return [
      ...(m.row === undefined ? [] : [[0, m.row]]),
      ...(m.column === undefined || c === undefined ? [] : [[1, c.x, halves[m.column] ?? 0]]),
    ];
  };

  let marks: Marks = { row: undefined, column: undefined };

  const api = {
    /** The ECharts instance: the e2e hook reads its option. */
    instance: chart,
    update(d: HovData) {
      if (chart.isDisposed()) return;
      data = d;
      wasNarrow = narrow();
      const small = wasNarrow;
      wasStep = stepOf(d.rowLabels.length);
      const step = wasStep;
      const last = d.rowLabels.length - 1;
      const xs = d.columns.map((c) => c.x);
      halves = xs.map((_, i) => half(xs, i));
      const halfAt = (x: number) => halves[xs.findIndex((v) => Math.abs(v - x) < 1e-6)] ?? 0;
      const items = d.cells.flatMap((cells, row) =>
        cells.map((cell, ci) => [
          xs[ci] ?? 0,
          row,
          halves[ci] ?? 0,
          cell.bin ?? NO_BIN,
          d.columns[ci]?.tidal ? 1 : 0,
          ci,
        ]),
      );
      const reach = MAX_HALF_KM;
      chart.setOption(
        {
          animation: false,
          grid: small ? GRID_NARROW : GRID,
          xAxis: {
            type: 'value',
            min: Math.min(...xs) - reach,
            max: Math.max(...xs) + reach,
            splitLine: { show: false },
            axisTick: { customValues: xs },
            axisLabel: {
              customValues: xs,
              showMinLabel: false,
              showMaxLabel: false,
              rotate: 60,
              hideOverlap: true,
              fontSize: small ? 10 : 11,
              width: small ? 64 : 80,
              overflow: 'truncate',
              formatter: (v: number) => {
                const i = xs.findIndex((x) => Math.abs(x - v) < 1e-6);
                return d.colLabels[i] ?? '';
              },
            },
          },
          yAxis: {
            type: 'category',
            data: [...d.rowLabels],
            axisTick: { show: false },
            splitLine: { show: false },
            axisLabel: {
              interval: (i: number) => (last - i) % step === 0,
              fontSize: small ? 10 : 11,
              width: small ? 88 : 116,
              overflow: 'truncate',
            },
          },
          tooltip: {
            trigger: 'item',
            renderMode: 'richText',
            confine: true,
            formatter: (p: { seriesId?: string; data?: unknown; dataIndex?: number }) => {
              const v = p.data;
              if (p.seriesId === 'gaps') return d.gapTexts[p.dataIndex ?? 0] ?? '';
              return p.seriesId === 'cells' && Array.isArray(v) ? d.tip(Number(v[5]), Number(v[1])) : '';
            },
          },
          series: [
            {
              id: 'gaps',
              type: 'custom',
              z: 1,
              clip: true,
              progressive: 0,
              renderItem: gapItem,
              emphasis: { disabled: true },
              data: d.gaps.map((g, i) => [g.fromX + halfAt(g.fromX), 0, g.toX - halfAt(g.toX), i]),
            },
            {
              id: 'cells',
              type: 'custom',
              z: 2,
              clip: true,
              progressive: 0,
              cursor: 'pointer',
              renderItem: cellItem,
              emphasis: { disabled: true },
              data: items,
            },
            {
              id: 'marker',
              type: 'custom',
              z: 3,
              silent: true,
              clip: true,
              progressive: 0,
              renderItem: markItem,
              data: markData(marks),
            },
          ],
        },
        { notMerge: true },
      );
    },
    /** The t line and the selected column move without a rebuild of the cells. */
    mark(next: Marks) {
      marks = next;
      if (chart.isDisposed()) return;
      chart.setOption({ series: [{ id: 'marker', data: markData(next) }] });
    },
    /** The viewport (client) pixel of a cell's centre, for the e2e hook; undefined while the chart has no such cell. */
    pixelOf(column: number, row: number): [number, number] | undefined {
      const c = data?.columns[column];
      if (c === undefined || row < 0 || row >= (data?.rowLabels.length ?? 0)) return undefined;
      const [px = Number.NaN, py = Number.NaN] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [
        c.x,
        row,
      ]) as number[];
      if (!Number.isFinite(px) || !Number.isFinite(py)) return undefined;
      const r = el.getBoundingClientRect();
      return [r.left + px, r.top + py];
    },
    dispose() {
      resize.disconnect();
      chart.dispose();
    },
  };
  return api;
}

export type HovChart = ReturnType<typeof createHovChart>;
