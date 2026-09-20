const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  PageBreak, LevelFormat, Header, Footer, PageNumber, TabStopType, LeaderType,
} = require('docx');
const fs = require('fs');

/* --------------------------------------------------------------- tokens */
const INK    = '141418';   // headings, key text
const BODY   = '2E2E34';   // body copy
const MUTED  = '6B6B73';   // secondary
const FAINT  = '9A9AA2';   // labels
const ACCENT = '17508F';   // one accent: numerals + key figures
const RULE   = 'DDDBD3';
const HAIR   = 'EBE9E2';
const TINT   = 'F5F4EF';
const FONT = 'Calibri', MONO = 'Consolas';

const CW = 9360;           // 6.5" content width

/* -------------------------------------------------------------- helpers */
const R = (text, o = {}) => new TextRun({
  text, font: o.font ?? FONT, size: o.size ?? 20,
  color: o.color ?? BODY, bold: o.bold, italics: o.italics,
  characterSpacing: o.track,
});

const P = (text, o = {}) => new Paragraph({
  spacing: { before: o.before ?? 0, after: o.after ?? 130, line: o.line ?? 268 },
  alignment: o.align, indent: o.indent, border: o.border,
  children: Array.isArray(text) ? text : [R(text, o)],
});

/** Section head: accent numeral, then title, with a hairline under. */
const H1 = (num, title) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 380, after: 150 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: INK, space: 8 } },
  children: [
    R(num + '  ', { size: 26, bold: true, color: ACCENT }),
    R(title, { size: 26, bold: true, color: INK }),
  ],
});

const H2 = (title) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 260, after: 90 },
  children: [R(title, { size: 21, bold: true, color: INK })],
});

const LABEL = (t) => new Paragraph({
  spacing: { before: 200, after: 70 },
  children: [R(t.toUpperCase(), { size: 16, bold: true, color: FAINT, track: 30 })],
});

const BULLET = (text) => new Paragraph({
  numbering: { reference: 'b', level: 0 },
  spacing: { after: 60, line: 264 },
  children: Array.isArray(text) ? text : [R(text)],
});
const NUM = (text) => new Paragraph({
  numbering: { reference: 'n', level: 0 },
  spacing: { after: 60, line: 264 },
  children: Array.isArray(text) ? text : [R(text)],
});

const MONO_LINE = (t, o = {}) => new Paragraph({
  spacing: { after: o.after ?? 40, line: 240 }, indent: { left: 340 },
  children: [R(t, { font: MONO, size: 18, color: o.bold ? INK : BODY, bold: o.bold })],
});

const EQ = (t) => new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 150, after: 150 },
  children: [R(t, { font: MONO, size: 20, color: INK })],
});

const SP = (h = 120) => new Paragraph({ spacing: { after: h }, children: [] });

const noB = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
};

/** Key-figure strip: big accent numbers with small labels under. */
const STATS = (items) => {
  const w = Math.floor(CW / items.length);
  return new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: items.map(() => w),
    borders: {
      ...noB,
      top: { style: BorderStyle.SINGLE, size: 6, color: INK },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    },
    rows: [new TableRow({
      children: items.map(([big, small]) => new TableCell({
        width: { size: w, type: WidthType.DXA },
        margins: { top: 170, bottom: 170, left: 0, right: 160 },
        children: [
          new Paragraph({ spacing: { after: 30, line: 240 },
            children: [R(big, { size: 34, bold: true, color: ACCENT })] }),
          new Paragraph({ spacing: { after: 0, line: 230 },
            children: [R(small, { size: 16, color: MUTED })] }),
        ],
      })),
    })],
  });
};

/** Quiet emphasis block: tinted, left rule, one or two lines. */
const NOTE = (lead, body) => new Table({
  width: { size: CW, type: WidthType.DXA }, columnWidths: [CW], borders: noB,
  rows: [new TableRow({ children: [new TableCell({
    width: { size: CW, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: TINT },
    margins: { top: 130, bottom: 130, left: 190, right: 190 },
    borders: { ...noB, left: { style: BorderStyle.SINGLE, size: 16, color: ACCENT } },
    children: [new Paragraph({ spacing: { after: 0, line: 258 }, children: [
      R(lead + '  ', { bold: true, size: 19, color: INK }),
      R(body, { size: 19, color: BODY }),
    ]})],
  })]})],
});

/** Table. cols = [{w, label, align}] */
const TABLE = (cols, rows, o = {}) => {
  const widths = cols.map((c) => c.w);
  const cell = (txt, i, opt = {}) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: opt.fill ? { type: ShadingType.CLEAR, fill: opt.fill } : undefined,
    margins: { top: 80, bottom: 80, left: i === 0 ? 0 : 120, right: 120 },
    children: [new Paragraph({
      alignment: cols[i].align === 'r' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      // keeps each row with the one after it, so the table does not break
      // across a page — every table here is well under a page tall.
      keepNext: opt.last !== true,
      spacing: { after: 0, line: 248 },
      children: Array.isArray(txt) ? txt : [R(String(txt), {
        size: opt.size ?? 18, bold: opt.bold,
        color: opt.color ?? (opt.bold ? INK : BODY),
        font: opt.mono ? MONO : FONT, track: opt.track,
      })],
    })],
  });
  return new Table({
    width: { size: CW, type: WidthType.DXA },
    columnWidths: widths,
    borders: {
      ...noB,
      top: { style: BorderStyle.SINGLE, size: 6, color: INK },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: INK },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: HAIR },
    },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: cols.map((c, i) =>
        cell(c.label.toUpperCase(), i, { bold: true, size: 15, color: FAINT, track: 24 })) }),
      ...rows.map((r, ri) => new TableRow({
        cantSplit: true,
        children: r.map((t, i) => cell(t, i, {
          bold: o.bold && o.bold.includes(ri),
          color: o.bold && o.bold.includes(ri) ? ACCENT : undefined,
          mono: o.mono && i >= (o.monoFrom ?? 1),
          last: ri === rows.length - 1,
        })),
      })),
    ],
  });
};

/* -------------------------------------------------------------- content */
const C = [];

/* ============================== COVER ============================== */
C.push(
  new Paragraph({ spacing: { before: 900, after: 0 }, children: [
    R('GridPoint', { size: 80, bold: true, color: INK, track: -14 }),
  ]}),
  new Paragraph({ spacing: { after: 320 }, children: [
    R('Where should the warehouse go?', { size: 26, color: MUTED }),
  ]}),
);

C.push(STATS([
  ['32.5%',  'cheaper than one optimally-sited depot'],
  ['₹33.0L', 'saved per year'],
  ['37 t',   'CO₂ avoided per year'],
  ['0.0001%', 'cross-validation gap'],
]));

C.push(SP(260));
C.push(P([
  R('Warehouse location optimisation for Indian last-mile delivery. Decides how many '
    + 'warehouses to build, where each one goes, and which neighborhoods it serves — by '
    + 'minimising real operating cost in rupees, and showing which of its answers are '
    + 'proven rather than merely good.', { size: 21, color: BODY }),
], { after: 300, line: 290 }));

C.push(TABLE(
  [{ w: 2100, label: '' }, { w: 7260, label: '' }],
  [
    ['Live application', 'gridpointsludge.vercel.app'],
    ['Source code', 'github.com/sakshath7408/gridpoint'],
    ['Problem statement', 'GRIDPOINT · Theme VECTOR · Hack-a-Matics 2026'],
  ],
));

C.push(SP(300));
C.push(LABEL('Contents'));
// Page numbers verified against the rendered PDF, not guessed. If content
// shifts, re-render and re-check: pdftotext -f N -l N <pdf> - | grep '^[0-9]  '
const TOC = [
  ['1', 'What it does and how to use it', 2],
  ['2', 'The mathematics', 3],
  ['3', 'How it compares', 5],
  ['4', 'Limitations and technical summary', 6],
];
for (const [n, t, pg] of TOC) {
  C.push(new Paragraph({
    spacing: { after: 60, line: 258 },
    tabStops: [{ type: TabStopType.RIGHT, position: CW, leader: LeaderType.DOT }],
    children: [
      R(n + '   ', { bold: true, size: 20, color: ACCENT }),
      R(t, { size: 20, color: INK }),
      R('\t', { size: 20 }),
      R(String(pg), { size: 20, color: MUTED }),
    ],
  }));
}
C.push(SP(260));
C.push(LABEL('Team'));
C.push(TABLE(
  [{ w: 2100, label: '' }, { w: 7260, label: '' }],
  [
    ['Tejas', 'Mathematical model and Python reference implementation'],
    ['Sakshath', 'Web application, cost model, AI component, deployment'],
    ['Rajath', 'Brute-force verifier'],
  ],
));
C.push(SP(150));
C.push(P([R('Every figure in this document is produced by the committed code.',
  { size: 17, color: MUTED, italics: true })]));

C.push(new Paragraph({ children: [new PageBreak()] }));

/* ========================= 1. PRODUCT ========================= */
C.push(H1('1', 'What it does and how to use it'));

C.push(P(
  'An operator serves a set of neighborhoods, each with a location and a daily order volume. '
  + 'Three decisions follow, usually made by intuition: how many warehouses, where, and who '
  + 'serves whom. GridPoint answers all three by minimising cost in rupees per day.',
));
C.push(P(
  'On twelve Bengaluru zones carrying 3,880 orders a day, it replaces a single central depot '
  + 'at ₹27,870/day with four warehouses at ₹18,824 — 32.5% cheaper. The single depot it is '
  + 'compared against is itself optimally sited, so that figure is not flattered by a straw man.',
  { after: 160 },
));

C.push(NOTE('In one line.',
  'Not a clustering demo with a map — a costing model that happens to be solved by a '
  + 'clustering algorithm, and that tells you which answers are proven.'));

C.push(H2('The run'));
C.push(P('Press Optimise, or ⌘/Ctrl + Enter. Four stages, each visible as it happens:'));
C.push(NUM([R('Place the warehouses. ', { bold: true, color: INK }), R('Weighted k-medians finds the K points minimising order-weighted cost.')]));
C.push(NUM([R('Assign every area. ', { bold: true, color: INK }), R('Each goes to whichever warehouse is genuinely cheapest to serve it from.')]));
C.push(NUM([R('Price the network. ', { bold: true, color: INK }), R('Trips, fuel, driver hours and rent become one rupees-per-day figure.')]));
C.push(NUM([R('Compare and prove. ', { bold: true, color: INK }), R('Against one depot, against k-means, against exhaustive search.')]));

C.push(H2('Data in'));
C.push(TABLE(
  [{ w: 1500, label: 'Route' }, { w: 7860, label: '' }],
  [
    ['Sample', 'Seven Indian metros: Bengaluru, Delhi NCR, Mumbai, Hyderabad, Chennai, Pune, Kolkata.'],
    ['Upload', 'Any CSV. Column names need not match ours — the AI component resolves them.'],
    ['Type', 'Paste rows as id, lat, lon, orders. Errors reported per row as you type.'],
  ],
));
C.push(SP(130));
C.push(P(
  'Each neighborhood needs a unique id, a valid lat/lon, and a non-negative order count. '
  + 'Validation failures are shown, not swallowed.',
));

C.push(H2('Controls'));
C.push(P('The K slider sets the number of warehouses. After a run the tool reports the cost optimum and offers a one-click jump to it — §2.4 explains why one exists.'));
C.push(SP(60));
C.push(TABLE(
  [
    { w: 2000, label: 'Vehicle' }, { w: 1560, label: 'Orders/trip', align: 'r' },
    { w: 1560, label: 'Fuel L/km', align: 'r' }, { w: 1560, label: 'km/h', align: 'r' },
    { w: 2680, label: 'CO₂ g/km', align: 'r' },
  ],
  [
    ['Two-wheeler', '25', '0.020', '34', '46'],
    ['Three-wheeler', '60', '0.033', '28', '76'],
    ['Delivery van', '180', '0.085', '30', '228'],
    ['Light truck', '420', '0.150', '26', '402'],
    ['Electric van', '150', '0.011', '30', '110'],
  ],
));
C.push(SP(130));
C.push(P([
  R('Four congestion profiles scale effective speed, and so driver cost per kilometre: '),
  R('free flow 1.00', { bold: true, color: INK }), R(' (night dispatch), '),
  R('light 1.25', { bold: true, color: INK }), R(' (off-peak), '),
  R('peak hour 1.85', { bold: true, color: INK }), R(' (Bengaluru 9am/6pm), '),
  R('gridlock 2.60', { bold: true, color: INK }), R(' (monsoon evening).'),
]));
C.push(P([
  R('Fuel price, driver wage and facility rent are live inputs. Two hard constraints can be '
    + 'switched on — a '), R('capacity cap', { bold: true, color: INK }),
  R(' per warehouse and a '), R('maximum service radius', { bold: true, color: INK }),
  R('. Violations are flagged on the map, not hidden.'),
]));
C.push(SP(60));
C.push(P('Five demand scenarios reshape volumes so you can test whether the answer moves: today, +40% growth, suburban sprawl, urban infill, downturn.'));

C.push(H2('The AI component'));
C.push(P([
  R('Real data never arrives with the column names you want. GridPoint embeds each header with '),
  R('Xenova/all-MiniLM-L6-v2', { font: MONO, size: 18, color: INK }),
  R(' on WebAssembly '), R('inside the browser', { bold: true, color: INK }),
  R(' — no API key, no server, nothing leaves the machine — and matches by meaning:'),
]));
C.push(SP(50));
C.push(TABLE(
  [{ w: 3200, label: 'Incoming header' }, { w: 3200, label: 'Mapped to' }, { w: 2960, label: 'Similarity', align: 'r' }],
  [
    ['Parcels Per Day', 'orders', '79%'],
    ['Locality Name', 'id', '72%'],
    ['Y Coordinate', 'lat', '50%'],
    ['X Coordinate', 'lon', '39%'],
  ],
));
C.push(SP(130));
C.push(NOTE('Those percentages are raw cosine similarity.',
  '39% looks weak but is a correct mapping — what matters is the margin over the runner-up. '
  + 'If the model fails to load, the tool falls back to an alias table and says so rather than '
  + 'pretending it used AI.'));

C.push(H2('Results out'));
C.push(TABLE(
  [{ w: 2100, label: 'Panel' }, { w: 7260, label: '' }],
  [
    ['Headline', 'Percentage cheaper than one central depot, and the rupee figures behind it.'],
    ['Statistics', 'Annual saving, CO₂ avoided, margin over an equivalent k-means network.'],
    ['Trade-off', 'Cost against K with the optimum starred. Click a bar to jump to that K.'],
    ['Costs', 'Fuel, driver time, facilities, cost per order, vehicle-km, CO₂, robustness.'],
    ['Areas', 'Every neighborhood, its volume, its depot, its distance.'],
    ['Proof', 'Which claim applies at this K, and the evidence behind it.'],
  ],
));
C.push(SP(130));
C.push(P('Copy summary, copy a permalink to the exact scenario, or export the network as CSV. Before/After toggles the baseline. Light and dark themes are separately colour-validated.'));



/* ========================= 2. MATHEMATICS ========================= */
C.push(H1('2', 'The mathematics'));

C.push(P([
  R('Neighborhood '), R('i', { italics: true }), R(' sits at pᵢ with wᵢ orders per day. Choose K '
    + 'warehouse locations — anywhere on the surface, not only at existing sites — to minimise'),
]));
C.push(EQ('f(X)  =  Σᵢ wᵢ · minⱼ d(pᵢ, xⱼ)   +   K · c_facility'));
C.push(P([
  R('where d is haversine distance. This is the '), R('weighted K-medians', { bold: true, color: INK }),
  R(' problem with a facility term.'),
]));

C.push(H2('2.1  k-medians, not k-means'));
C.push(P([
  R('Delivery cost is '), R('linear', { bold: true, color: INK }),
  R(' in distance — twice as far is twice the fuel and twice the driver-hour. k-means minimises '),
  R('squared', { bold: true, color: INK }),
  R(' distance, which is a different objective and picks a different siting: under d², one '
    + 'distant high-volume zone drags a warehouse toward it far harder than its real cost '
    + 'justifies, and everyone left behind pays.'),
]));
C.push(P(
  'The minimisers differ even for one facility. Squared gives the weighted centroid, in closed '
  + 'form. Linear gives the weighted geometric median, which has no closed form for n ≥ 3 and '
  + 'must be found iteratively.',
));
C.push(P('We measure the difference rather than assert it — both networks, same data, same K:', { after: 130 }));
C.push(TABLE(
  [{ w: 1200, label: 'K', align: 'r' }, { w: 3200, label: 'k-medians /day', align: 'r' },
   { w: 2600, label: 'k-means penalty', align: 'r' }, { w: 2360, label: '' }],
  [
    ['2', '₹23,448', '+6.00%', ''],
    ['3', '₹20,521', '+2.81%', ''],
    ['4', '₹18,824', '+2.07%', 'optimum'],
    ['5', '₹19,125', '+1.22%', ''],
  ],
  { bold: [2] },
));
C.push(SP(130));
C.push(NOTE('The wrong objective costs 1.2–6.0% of total network cost,',
  'permanently, for no benefit — up to ₹5.5 lakh a year on this dataset, thrown away by '
  + 'reaching for the more familiar algorithm. Measured on the delivery budget alone, which '
  + 'is the part siting can actually move, the gap is 3.6–8.1%.'));

C.push(H2('2.2  The cost model is free'));
C.push(P('For neighborhood i served from warehouse w:'));
C.push(MONO_LINE('roadKmᵢ     = d(pᵢ, w) × ρ             ρ = 1.32 detour factor'));
C.push(MONO_LINE('tripsᵢ      = ⌈wᵢ / Q⌉                 Q = vehicle capacity'));
C.push(MONO_LINE('vehicleKmᵢ  = 2 × roadKmᵢ × tripsᵢ      round trips'));
C.push(MONO_LINE('r           = φ·P_fuel + u + W/v_eff   ₹ per vehicle-km'));
C.push(MONO_LINE('costᵢ       = d(pᵢ, w) × [ 2 · tripsᵢ · ρ · r ]', { bold: true, after: 150 }));
C.push(P([
  R('The bracketed term is '), R('constant in w', { bold: true, color: INK }),
  R('. So minimising rupees is still exactly weighted k-medians — the whole vehicle, fuel, '
    + 'traffic and wage model collapses into the weights. Five fleets and four congestion '
    + 'profiles cost the optimiser nothing.'),
]));
C.push(P([
  R('Stated openly: ', { bold: true, color: INK }),
  R('we price the trunk leg plus facilities. Distribution inside a neighborhood is excluded '
    + 'because it is near-invariant to depot position and cannot move the optimum.'),
]));

C.push(H2('2.3  What is proven, and what is not'));
C.push(P([R('K = 1 — proven globally optimal. ', { bold: true, color: INK }),
  R('Each ‖x − pᵢ‖ is a norm, hence convex; a non-negative weighted sum of convex functions is '
    + 'convex; so any local minimum is the global one. Weiszfeld’s iteration')]));
C.push(EQ('x⁽ᵐ⁺¹⁾ = Σᵢ (wᵢpᵢ / ‖x⁽ᵐ⁾−pᵢ‖) / Σᵢ (wᵢ / ‖x⁽ᵐ⁾−pᵢ‖)'));
C.push(P(
  'is a descent method on that objective, so its fixed point is the global minimum. GridPoint '
  + 'is not reporting the best location it found — it is reporting the best that exists.',
));
C.push(P([R('Caveat. ', { bold: true, italics: true, color: INK }),
  R('The iteration is undefined if an iterate lands exactly on a demand point. We floor the '
    + 'denominator away from zero; a production version should use the Vardi–Zhang '
    + 'modification.', { italics: true })]));
C.push(SP(40));
C.push(P([R('K > 1 — NP-hard, so we certify instead. ', { bold: true, color: INK }),
  R('Two things are proven rather than one thing overclaimed:')]));
C.push(BULLET([R('Never worse than exhaustive search. ', { bold: true, color: INK }),
  R('All C(n,K) ways of siting K depots on the demand points are enumerated exactly — 495 '
    + 'subsets at n=12, K=4 — and warm-start the solver. Lloyd’s decreases monotonically, so '
    + 'the result cannot be worse. That is a guarantee.')]));
C.push(BULLET([R('Certified locally optimal. ', { bold: true, color: INK }),
  R('Each warehouse is perturbed across a 21×21 lattice within 2 km — 1,764 probes at K=4 — '
    + 'and none improves the objective. Certified to ~100 m, finer than a lease.')]));

C.push(H2('2.4  How many warehouses'));
C.push(P('Delivery cost falls with K; rent rises linearly. The sum has a genuine interior minimum.', { after: 130 }));
C.push(TABLE(
  [{ w: 1000, label: 'K', align: 'r' }, { w: 2100, label: 'Delivery', align: 'r' },
   { w: 2100, label: 'Facilities', align: 'r' }, { w: 2100, label: 'Total/day', align: 'r' },
   { w: 2060, label: 'vs one depot', align: 'r' }],
  [
    ['1', '₹25,370', '₹2,500', '₹27,870', '—'],
    ['2', '₹18,448', '₹5,000', '₹23,448', '15.9%'],
    ['3', '₹13,021', '₹7,500', '₹20,521', '26.4%'],
    ['4', '₹8,824', '₹10,000', '₹18,824', '32.5%'],
    ['5', '₹6,625', '₹12,500', '₹19,125', '31.4%'],
    ['6', '₹5,174', '₹15,000', '₹20,174', '27.6%'],
    ['8', '₹2,704', '₹20,000', '₹22,704', '18.5%'],
  ],
  { bold: [3] },
));
C.push(SP(130));
C.push(P([
  R('A true interior minimum — K=5 is ₹301/day '), R('worse', { italics: true }),
  R(', not better. The curve turns. At K=4: ₹33.0 lakh saved a year, 37 t CO₂ avoided.'),
]));

C.push(H2('2.5  Robustness and cross-validation'));
C.push(P(
  'Demand resampled 16 times at ±30%, comparing keeping today’s siting against re-optimising '
  + 'with perfect hindsight. Mean regret 0.64%, worst case 2.77%. Since relocating a warehouse '
  + 'costs far more than 0.64% of daily operating cost, the correct decision is to build and '
  + 'not re-site.',
));
C.push(P(
  'The model was implemented twice independently — Python on a tangent plane, TypeScript on the '
  + 'sphere, different seeding, different arithmetic:',
  { after: 130 },
));
C.push(TABLE(
  [{ w: 1000, label: 'K', align: 'r' }, { w: 2700, label: 'Python (order-km)', align: 'r' },
   { w: 2700, label: 'TypeScript', align: 'r' }, { w: 1500, label: 'Gap', align: 'r' },
   { w: 1460, label: 'Worst site', align: 'r' }],
  [
    ['1', '55,490.66', '55,490.74', '+0.000%', '0.000 km'],
    ['3', '30,378.14', '30,378.17', '+0.000%', '0.002 km'],
    ['5', '17,904.77', '17,904.80', '+0.000%', '0.000 km'],
  ],
));
C.push(SP(130));
C.push(NOTE('Agreement to 0.0001% on cost and ~2 m on position.',
  'Reproducible with npm run crossval. Two independent implementations converging is the '
  + 'strongest evidence that the result is a property of the mathematics, not of one codebase.'));



/* ========================= 3. COMPARISON ========================= */
C.push(H1('3', 'How it compares'));
C.push(P('Not against enterprise network-design suites, which do far more — against what a team would realistically reach for.', { after: 130 }));
C.push(TABLE(
  [{ w: 2400, label: 'Approach' }, { w: 3400, label: 'What it gets wrong' }, { w: 3560, label: 'GridPoint' }],
  [
    ['Intuition / existing sites', 'Anchored on property already leased.', 'Searches the continuous plane.'],
    ['k-means clustering', 'Squared distance — 1.2–6.0% dearer at equal K.', 'Minimises the actual linear cost.'],
    ['Centre-of-gravity sheet', 'Weighted centroid — k-means renamed.', 'Cost model, constraints, optimum in K.'],
    ['Generic solver', 'A number, with no account of confidence.', 'Proven at K=1, certified above.'],
    ['Enterprise network design', 'Powerful, but days to model a question.', 'An answer in under a second.'],
  ],
));

C.push(H2('Why the mathematics holds up'));
C.push(BULLET([R('The objective matches the cost. ', { bold: true, color: INK }), R('Linear because fuel and driver-hours are linear — and we quantify what choosing otherwise costs.')]));
C.push(BULLET([R('Proven where provable, certified where not. ', { bold: true, color: INK }), R('K=1 by convexity; K>1 is NP-hard, so we certify — and say which applies in the interface.')]));
C.push(BULLET([R('An exhaustive benchmark. ', { bold: true, color: INK }), R('All C(n,K) discrete sitings enumerated as a floor the answer cannot fall below.')]));
C.push(BULLET([R('K is derived, not assumed. ', { bold: true, color: INK }), R('The infrastructure–delivery trade-off produces a genuine interior minimum.')]));
C.push(BULLET([R('Robustness measured, not claimed. ', { bold: true, color: INK }), R('0.64% mean regret under ±30% demand movement.')]));
C.push(BULLET([R('Independently cross-validated. ', { bold: true, color: INK }), R('Two languages, two geometries, agreeing to 0.0001%.')]));

/* ========================= 4. LIMITS ========================= */
C.push(H1('4', 'Limitations and technical summary'));
C.push(P('Stated because a model whose limits are not stated should not be trusted.'));
C.push(BULLET([R('Great-circle × 1.32 ', { bold: true, color: INK }), R('stands in for road distance — a routing API would add a live dependency we refused.')]));
C.push(BULLET([R('Independent radial trips. ', { bold: true, color: INK }), R('Multi-drop routing would lower absolute cost but affects all sitings alike, so the argmin largely holds.')]));
C.push(BULLET([R('Uniform facility cost. ', { bold: true, color: INK }), R('Real rents vary by location. This is the most valuable extension.')]));
C.push(BULLET([R('K > 1 is certified, not proven. ', { bold: true, color: INK }), R('Repeated because it is the claim most likely to be over-read.')]));
C.push(BULLET([R('Static demand within a run. ', { bold: true, color: INK }), R('Scenarios model shifts between runs, not intra-day variation.')]));
C.push(BULLET([R('Sample volumes are illustrative. ', { bold: true, color: INK }), R('Coordinates are real, validated locality centroids; order counts are invented and labelled so.')]));

C.push(SP(140));
C.push(TABLE(
  [{ w: 2200, label: 'Item' }, { w: 7160, label: 'Detail' }],
  [
    ['Algorithm', 'Weighted k-medians; Lloyd’s with a geometric-median (Weiszfeld) update, k-means++ seeding, warm-started from the exact discrete p-median'],
    ['Distance', 'Haversine × 1.32 road detour factor'],
    ['Cost model', 'Fuel + upkeep + driver time on the trunk leg, plus flat facility cost per day'],
    ['AI component', 'Xenova/all-MiniLM-L6-v2 via Transformers.js on WebAssembly, in-browser'],
    ['Stack', 'Next.js 15, React 19, TypeScript, MapLibre GL JS; Python 3 reference'],
    ['Architecture', 'Entirely client-side — no backend, no database, no API keys'],
    ['Tests', '70 passing across geometry, cost model and all eight bonus features'],
    ['Cross-validation', 'Python vs TypeScript to 0.0001% on cost, ~2 m on position'],
  ],
));



/* ------------------------------------------------------------ assemble */
const doc = new Document({
  creator: 'GridPoint',
  title: 'GridPoint — User Manual',
  description: 'Warehouse location optimisation for Indian last-mile delivery',
  numbering: { config: [
    { reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '—',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 420, hanging: 240 } },
               run: { color: ACCENT, bold: true } } }] },
    { reference: 'n', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1',
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 420, hanging: 280 } },
               run: { color: ACCENT, bold: true } } }] },
  ]},
  styles: { default: { document: {
    run: { font: FONT, size: 20, color: BODY },
    paragraph: { spacing: { line: 268 } },
  }}},
  sections: [{
    properties: { page: { margin: { top: 1300, right: 1440, bottom: 1200, left: 1440 } } },
    headers: { default: new Header({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT, spacing: { after: 0 },
      children: [R('GRIDPOINT', { size: 14, color: FAINT, bold: true, track: 40 })],
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT, spacing: { before: 0 },
      children: [new TextRun({ children: [PageNumber.CURRENT], size: 16, color: FAINT, font: FONT })],
    })] }) },
    children: C,
  }],
});

Packer.toBuffer(doc).then((b) => {
  fs.writeFileSync('/home/claude/manual/GridPoint-User-Manual.docx', b);
  console.log('written', b.length, 'bytes');
});
