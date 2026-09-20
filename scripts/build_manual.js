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
/* -------------------------------------------------------------- content */
const C = [];

/* ============================== COVER ============================== */
C.push(
  new Paragraph({ spacing: { before: 900, after: 0 }, children: [
    R('Sludge', { size: 80, bold: true, color: INK, track: -14 }),
  ]}),
  new Paragraph({ spacing: { after: 320 }, children: [
    R('User manual', { size: 26, color: MUTED }),
  ]}),
);

C.push(STATS([
  ['9',  'Indian city datasets built in'],
  ['5',  'vehicle fleets to model'],
  ['17', 'features from the brief'],
  ['0',  'servers or API keys needed'],
]));

C.push(SP(260));
C.push(P([
  R('Sludge decides how many warehouses to build, where each one goes, and which '
    + 'neighborhoods it serves — by minimising real operating cost in rupees per day. '
    + 'This manual explains every control in the interface: what it does, and why it is '
    + 'there. No mathematics background is assumed.', { size: 21, color: BODY }),
], { after: 300, line: 290 }));

C.push(TABLE(
  [{ w: 2100, label: '' }, { w: 7260, label: '' }],
  [
    ['Live application', 'gridpointsludge.vercel.app'],
    ['Runs in', 'Any modern browser. Nothing to install.'],
    ['Your data', 'Never leaves your machine.'],
  ],
));

C.push(SP(300));
C.push(LABEL('Contents'));
const TOC = [
  ['1', 'Getting started', 2],
  ['2', 'Loading your data', 3],
  ['3', 'Choosing how many warehouses', 4],
  ['4', 'Fleet, costs and constraints', 4],
  ['5', 'Reading the results', 5],
  ['6', 'Sharing and exporting', 6],
  ['7', 'The numbers behind the model', 6],
  ['8', 'If something looks wrong', 7],
];
for (const [n, t, pg] of TOC) {
  C.push(new Paragraph({
    spacing: { after: 60, line: 258 },
    tabStops: [{ type: TabStopType.RIGHT, position: CW, leader: LeaderType.DOT }],
    children: [
      R(n + '   ', { bold: true, size: 20, color: ACCENT }),
      R(t, { size: 20, color: INK }),
      R('\t', { size: 20 }),
      R(String(pg), { size: 20, color: MUTED }),
    ],
  }));
}

C.push(new Paragraph({ children: [new PageBreak()] }));

/* ========================= 1. GETTING STARTED ========================= */
C.push(H1('1', 'Getting started'));

C.push(P(
  'Sludge answers three questions a delivery operator actually has: how many warehouses to '
  + 'build, where to put them, and which neighborhoods each one should serve. You give it '
  + 'locations and daily order volumes; it gives you a costed answer.',
));

C.push(H2('The sixty-second version'));
C.push(NUM('Pick a sample city, or upload your own CSV.'));
C.push(NUM('Press Optimise. Warehouses appear on the map, colour-coded by who they serve.'));
C.push(NUM('Click "Use the optimum" to let Sludge choose the number of warehouses for you.'));
C.push(NUM('Read the result: the saving, the cost per day, and where the money goes.'));
C.push(SP(140));

C.push(NOTE('Everything is local.',
  'There is no server and no API key. The optimiser, the cost model and the AI column '
  + 'mapper all run inside your browser, so your data never leaves your machine and '
  + 'nothing can fail mid-demonstration because a service was slow.'));

C.push(SP(200));
C.push(H2('The three columns'));
C.push(P('The screen is divided by what each part is for.', { after: 130 }));

C.push(TABLE(
  [{ w: 2000, label: 'Where' }, { w: 7360, label: 'What lives there' }],
  [
    ['Left', 'Everything you set. Your data, the number of warehouses, the fleet and cost assumptions, and any constraints.'],
    ['Centre', 'The map. Neighborhoods as circles sized by order volume, warehouses as labelled markers, and lines showing who serves whom.'],
    ['Right', 'Everything Sludge tells you. Before you run it, the four steps it will take. Afterwards, the result and the evidence behind it.'],
  ],
));

C.push(SP(200));
C.push(H2('Two things worth knowing first'));

C.push(TABLE(
  [{ w: 2400, label: 'Control' }, { w: 6960, label: 'Why it is there' }],
  [
    ['All 17 features', 'Every requirement from the brief, mapped to the control that satisfies it. Click any row and Sludge scrolls to that control and highlights it. Use this if you are looking for something and cannot find it.'],
    ['Light / dark', 'The interface ships dark. The toggle switches to a light theme; both are checked for colour-blind separation and text contrast, so nothing depends on colour alone.'],
  ],
));

C.push(new Paragraph({ children: [new PageBreak()] }));

/* ========================= 2. DATA ========================= */
C.push(H1('2', 'Loading your data'));

C.push(P(
  'Sludge needs four things about each neighborhood: an identifier, a latitude, a longitude, '
  + 'and how many orders it takes in a day. There are three ways to provide them.',
));

C.push(TABLE(
  [{ w: 1700, label: 'Tab' }, { w: 7660, label: 'What it is for' }],
  [
    ['Sample', 'Nine built-in datasets — Bengaluru, Delhi NCR, Mumbai, Hyderabad, Chennai, Pune and Kolkata. Use these to try the tool, or to compare how the answer changes between cities.'],
    ['Upload', 'Your own CSV. Column names do not have to match ours — see below.'],
    ['Type', 'Paste or type rows directly. Useful for a quick what-if with a handful of areas.'],
  ],
));

C.push(SP(200));
C.push(H2('Why your column names do not matter'));

C.push(P(
  'Real spreadsheets do not have columns called id, lat, lon and orders. They have '
  + '"Locality Name", "Y Coordinate" and "Parcels Per Day". A fixed list of aliases only '
  + 'recognises the headers somebody thought of in advance, and fails on the first '
  + 'unfamiliar file.',
));

C.push(P(
  'So Sludge reads your headers by meaning. A small language model runs inside the browser, '
  + 'compares each of your column names against what each field means, and matches them up. '
  + 'It is the only place any AI is involved, and it touches nothing but the column names.',
));

C.push(SP(140));
C.push(TABLE(
  [{ w: 2600, label: 'Your header' }, { w: 1200, label: '' }, { w: 5560, label: 'Understood as' }],
  [
    ['Parcels Per Day', '→', 'orders — daily order volume'],
    ['Y Coordinate', '→', 'lat — latitude'],
    ['Locality Name', '→', 'id — the area name'],
  ],
));

C.push(SP(160));
C.push(NOTE('If the model cannot load,',
  'Sludge falls back to a fixed alias table and says so in the interface rather than '
  + 'pretending the model ran. Nothing else in the tool depends on it: the optimisation, '
  + 'the cost model and the map are pure arithmetic.'));

C.push(SP(200));
C.push(H2('When a row is wrong'));
C.push(P(
  'Every row is validated as it loads. A bad coordinate or a missing order count is '
  + 'reported against that row, and the rest of the file still loads. A single malformed '
  + 'line should not cost you the whole upload.',
));

C.push(new Paragraph({ children: [new PageBreak()] }));

/* ========================= 3. K ========================= */
C.push(H1('3', 'Choosing how many warehouses'));

C.push(P(
  'More warehouses mean shorter trips but more rent. Fewer mean cheaper rent but longer '
  + 'driving. There is a number that balances the two, and Sludge will find it for you.',
));

C.push(TABLE(
  [{ w: 2700, label: 'Control' }, { w: 6660, label: 'What it does' }],
  [
    ['Warehouses (K)', 'Sets how many warehouses to place, from one to eight. Move it and press Optimise to see that many.'],
    ['Use the optimum', 'Jumps straight to the number that costs least. Sludge has already tested every value of K in the background.'],
    ['Optimise', 'Runs the placement. Keyboard shortcut: Command-Return.'],
    ['Before / After', 'Switches the map between a single central depot and the optimised network, so you can see what changed.'],
  ],
));

C.push(SP(200));
C.push(H2('The trade-off chart'));
C.push(P(
  'Under the result you will find a chart with one bar per value of K, split into delivery '
  + 'cost and facility cost. Delivery falls as K rises; facilities climb in a straight line. '
  + 'The total dips and then turns back up, and the lowest point is starred.',
));
C.push(P(
  'This is the whole argument for the tool in one picture: there is a right answer, and it '
  + 'is neither "as few as possible" nor "as many as we can afford".',
));

C.push(SP(240));

/* ========================= 4. FLEET AND COSTS ========================= */
C.push(H1('4', 'Fleet, costs and constraints'));

C.push(P(
  'These controls describe your operation. They are collapsed by default — open a section '
  + 'to change it. Each one shows the value it is currently using and, underneath, where '
  + 'that number came from.',
));

C.push(H2('Fleet and costs'));
C.push(TABLE(
  [{ w: 2300, label: 'Control' }, { w: 7060, label: 'What it does, and why it matters' }],
  [
    ['Vehicle', 'Five fleets from two-wheeler to light truck, plus an electric van. Capacity per trip is what really matters: a bigger vehicle makes fewer trips, which changes where the best warehouse sits.'],
    ['Traffic', 'Four congestion profiles, from free-flowing night roads to a monsoon-evening standstill. Congestion slows the fleet, which raises driver cost per kilometre.'],
    ['Fuel', 'Price per litre. Change it to see how sensitive your network is to the pump.'],
    ['Driver', 'Rider cost per hour to you as the operator, including what you carry beyond the headline wage.'],
    ['Facility rent', 'Cost per warehouse per day. This is the number that decides how many warehouses are worth building — raise it and the optimum shifts towards fewer, larger sites.'],
  ],
));

C.push(SP(180));
C.push(NOTE('The electric van is priced separately.',
  'It charges from the grid, so its energy cost does not move with the petrol slider. Its '
  + 'emissions are grid emissions rather than zero — cleaner than a diesel van, but not '
  + 'nothing, which is the honest number.'));

C.push(SP(200));
C.push(H2('Constraints'));
C.push(TABLE(
  [{ w: 2300, label: 'Control' }, { w: 7060, label: 'What it does, and why it matters' }],
  [
    ['Capacity cap', 'Limits how many orders a day one warehouse may take. Turn it on when a site physically cannot absorb everything nearest to it, and assignment will route the overflow elsewhere.'],
    ['Maximum service radius', 'Limits how far a warehouse may serve. Anything beyond the limit is flagged on the map rather than quietly hidden, because an unserviceable area is a decision you need to see.'],
    ['Demand scenario', 'Re-runs against a different future: growth, suburban sprawl, urban infill or a downturn. Warehouses last years, so the right question is not only what is cheapest today.'],
  ],
));

C.push(SP(240));

/* ========================= 5. RESULTS ========================= */
C.push(H1('5', 'Reading the results'));

C.push(H2('The headline'));
C.push(P(
  'The large percentage is how much cheaper the optimised network is than running everything '
  + 'from one depot. Beneath it are the two costs being compared, per day.',
));
C.push(NOTE('The comparison is deliberately strict.',
  'The single depot it is measured against has itself been placed optimally by the same '
  + 'solver — not dumped in the middle of the map. Comparing against a badly-sited depot '
  + 'would produce a bigger number and mean less.'));

C.push(SP(200));
C.push(H2('The three tiles'));
C.push(TABLE(
  [{ w: 2300, label: 'Tile' }, { w: 7060, label: 'What it tells you' }],
  [
    ['Saved per year', 'The daily saving over a year of operation, at today’s order volume.'],
    ['CO₂ avoided', 'Emissions not produced, because the fleet drives fewer kilometres. Based on your chosen vehicle.'],
    ['vs k-means', 'How much more the same network would cost if it had been placed by ordinary clustering instead. This is the value of using the right method.'],
  ],
));

C.push(SP(200));
C.push(H2('The map'));
C.push(TABLE(
  [{ w: 2600, label: 'What you see' }, { w: 6760, label: 'What it means' }],
  [
    ['Circles', 'Neighborhoods. Area is proportional to daily orders, so the busiest areas are visibly the biggest.'],
    ['Labelled markers', 'Warehouses. The label shows each one’s daily load. W1 is always the busiest, so two screenshots can be compared.'],
    ['Coloured lines', 'Which warehouse serves which neighborhood. Hover a warehouse to isolate its territory.'],
    ['Amber outline', 'An area outside your maximum service radius.'],
  ],
));

C.push(SP(200));
C.push(H2('The four tabs'));
C.push(TABLE(
  [{ w: 1700, label: 'Tab' }, { w: 7660, label: 'What it holds' }],
  [
    ['Costs', 'The full daily breakdown — fuel and upkeep, driver time, facilities, cost per order, vehicle-kilometres and CO₂.'],
    ['Areas', 'Every neighborhood, which warehouse serves it, and what it costs to serve.'],
    ['Proof', 'How confident Sludge is in this answer, and why. See below.'],
    ['Robustness', 'What happens if demand moves. Sludge re-runs with order volumes shifted up and down, and reports how much worse keeping these warehouses would be than re-optimising with hindsight. A low number means the answer is not tuned to one snapshot.'],
  ],
));

C.push(SP(200));
C.push(H2('What the Proof tab is telling you'));
C.push(P(
  'Sludge separates what it can prove from what it has merely searched for, because the '
  + 'difference matters when you are spending money on a building.',
));
C.push(TABLE(
  [{ w: 1700, label: 'Case' }, { w: 7660, label: 'What Sludge claims' }],
  [
    ['One warehouse', 'Proven to be the best possible position. Not "the best we found" — the best that exists.'],
    ['More than one', 'Certified rather than proven. Sludge checks its answer against an exhaustive search over every candidate siting, and separately confirms that nudging any warehouse in any direction makes things worse. That is a strong guarantee, and it is not the same as proof.'],
  ],
));

C.push(SP(240));

/* ========================= 6. SHARING ========================= */
C.push(H1('6', 'Sharing and exporting'));

C.push(P('Three buttons sit above the result.', { after: 130 }));
C.push(TABLE(
  [{ w: 2100, label: 'Button' }, { w: 7260, label: 'What you get' }],
  [
    ['Copy summary', 'A short plain-text account of this scenario — the network, the saving, the optimum, the fleet and cost assumptions. Ready to paste into a message or a report.'],
    ['Copy link', 'A URL that reopens this exact scenario, with the same data, K and settings. Send it to a colleague and they see what you see.'],
    ['Export CSV', 'Warehouse coordinates and the full neighborhood-to-warehouse assignment, for use elsewhere.'],
  ],
));

C.push(SP(240));

/* ========================= 7. NUMBERS ========================= */
C.push(H1('7', 'The numbers behind the model'));

C.push(P(
  'Every cost parameter shows its value, its reasoning and a source, next to the control it '
  + 'governs. You can change any of them. The defaults are these.',
));

C.push(TABLE(
  [{ w: 2500, label: 'Parameter' }, { w: 1900, label: 'Default', align: 'r' }, { w: 4960, label: 'Basis' }],
  [
    ['Petrol price', '₹110.93/L', 'Bengaluru pump price on the day the model was calibrated.'],
    ['Rider cost', '₹120/hour', 'Metro delivery partners gross ₹15,000–30,000 a month over roughly 208 paid hours.'],
    ['Facility rent', '₹2,500/day', 'A 500–800 sq ft micro-hub, about ₹75,000 a month. A full tier-1 dark store is nearer ₹7,800/day — try it on the slider.'],
    ['Two-wheeler load', '25 per trip', 'An urban rider completes 80–100 deliveries a day across three or four loads.'],
    ['Road detour factor', '× 1.32', 'Streets are not straight lines. Dense urban networks measure between 1.2 and 1.4.'],
  ],
));

C.push(SP(180));
C.push(NOTE('What is counted, and what is not.',
  'Sludge prices the trunk leg — depot to neighborhood and back — plus facilities. '
  + 'Delivery inside a neighborhood is excluded, because it barely changes with where the '
  + 'depot sits and so cannot affect which siting wins. That makes these figures right for '
  + 'comparing sitings, which is what the tool is for, and smaller than a full last-mile '
  + 'cost. It is stated here and in the interface rather than left to be discovered.'));

C.push(SP(240));

/* ========================= 8. TROUBLESHOOTING ========================= */
C.push(H1('8', 'If something looks wrong'));

C.push(TABLE(
  [{ w: 3100, label: 'What you see' }, { w: 6260, label: 'What it means' }],
  [
    ['The map is blank', 'Map tiles are still loading, or your network is blocking them. The optimisation is unaffected — the result panel is still correct.'],
    ['"Loads on first use" next to AI component', 'Normal. The column-matching model downloads the first time you upload a file, not on page load.'],
    ['An area has an amber outline', 'It falls outside your maximum service radius. Either raise the radius, add a warehouse, or accept that it is unserviceable.'],
    ['Changing the city seems to keep the old answer', 'Press Optimise again. Sludge clears the previous result when your data changes, so what you are seeing is the un-optimised view.'],
    ['A warehouse sits where nobody lives', 'That is usually correct. The solver weights by order volume, so it sits near the demand, not near the map’s centre.'],
    ['The numbers moved after changing fleet', 'Expected. A different vehicle carries a different number of orders per trip, which changes trip counts, cost, and sometimes the best siting.'],
  ],
));

C.push(SP(200));
C.push(P([
  R('Every figure in this manual is produced by the committed code. ', { size: 17, color: MUTED, italics: true }),
  R('gridpointsludge.vercel.app', { size: 17, color: ACCENT, italics: true }),
]));
const doc = new Document({
  creator: 'Sludge',
  title: 'Sludge — User Manual',
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
      children: [R('SLUDGE', { size: 14, color: FAINT, bold: true, track: 40 })],
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
