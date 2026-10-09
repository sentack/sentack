#!/usr/bin/env node
// Renders the profile README's GitHub activity cards as SVG, styled to match sentack.dev.
//
//   GH_TOKEN=<token> node .github/scripts/profile-cards.mjs [outDir]
//
// GH_TOKEN: a PAT with `repo` + `read:user` scopes also counts private repos and
// contributions; the default Actions token only sees public data.
// DATA_FILE: render from a JSON snapshot instead of calling the API.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'dist';
const USER = process.env.GH_USER || 'sentack';
const TOKEN = process.env.GH_TOKEN;
const DAY = 86_400_000;

const W = 900;
const PAD = 32;
const C = {
  bg: '#0c0c0f',
  tile: '#17171c',
  line: '#ffffff12',
  fg: '#f3f1ec',
  muted: '#a3a1a8',
  subtle: '#6d6b74',
  faint: '#45444b',
  ember: '#ff5f2e',
  emberSoft: '#ffb08f',
};
const HEAT = ['#17171c', '#4a1c0f', '#8a3216', '#d14a1f', '#ff5f2e'];

// ---------------------------------------------------------------- data

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'profile-cards' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GitHub API: ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}

const REPOS = `query($login: String!, $after: String) {
  user(login: $login) {
    login name createdAt
    followers { totalCount }
    repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner stargazerCount
        languages(first: 25, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
      }
    }
  }
}`;

const CONTRIBUTIONS = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions totalPullRequestContributions
      totalPullRequestReviewContributions totalIssueContributions restrictedContributionsCount
      commitContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
      pullRequestContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
      issueContributionsByRepository(maxRepositories: 100) { repository { nameWithOwner } }
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

async function fetchData() {
  if (!TOKEN) throw new Error('Set GH_TOKEN (or DATA_FILE to render a snapshot).');

  let user;
  let after = null;
  const repos = [];
  do {
    ({ user } = await gql(REPOS, { login: USER, after }));
    repos.push(...user.repositories.nodes);
    after = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (after);

  const langs = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const lang = langs.get(node.name) ?? { name: node.name, color: node.color, size: 0 };
      lang.size += size;
      langs.set(node.name, lang);
    }
  }

  // contributionsCollection spans at most a year, so walk back from today to the join date.
  const created = new Date(user.createdAt);
  const days = new Map();
  // Owned repos plus every repo contributed to, so org work counts too.
  const touched = new Set(repos.map((r) => r.nameWithOwner));
  let year;
  for (let to = new Date(); to > created; ) {
    const from = new Date(Math.max(to - 365 * DAY, created));
    const { user: { contributionsCollection: c } } = await gql(CONTRIBUTIONS, {
      login: USER,
      from: from.toISOString(),
      to: to.toISOString(),
    });
    year ??= c;
    for (const key of ['commit', 'pullRequest', 'pullRequestReview', 'issue']) {
      for (const { repository } of c[`${key}ContributionsByRepository`]) touched.add(repository.nameWithOwner);
    }
    for (const week of c.contributionCalendar.weeks) {
      for (const { date, contributionCount } of week.contributionDays) {
        days.set(date, Math.max(days.get(date) ?? 0, contributionCount));
      }
    }
    to = from;
  }
  if (year.restrictedContributionsCount) {
    console.log(
      `::warning::${year.restrictedContributionsCount} private contributions are hidden from this token, so commits, ` +
        'PRs, reviews and repos undercount. Add a classic PAT (repo, read:user, read:org) as the PROFILE_TOKEN secret.',
    );
  }

  const sortedDays = [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, count]) => ({ date, count }));
  return {
    login: user.login,
    name: user.name,
    since: created.getUTCFullYear(),
    generatedAt: new Date().toISOString(),
    days: sortedDays,
    allTime: sortedDays.reduce((n, d) => n + d.count, 0),
    year: {
      total: year.contributionCalendar.totalContributions,
      commits: year.totalCommitContributions,
      prs: year.totalPullRequestContributions,
      reviews: year.totalPullRequestReviewContributions,
      issues: year.totalIssueContributions,
    },
    repos: touched.size,
    ownedRepos: user.repositories.totalCount,
    stars: repos.reduce((n, r) => n + r.stargazerCount, 0),
    followers: user.followers.totalCount,
    languages: [...langs.values()].sort((a, b) => b.size - a.size),
  };
}

// ---------------------------------------------------------------- helpers

const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
const shortDate = (iso) => utc(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const r1 = (n) => Math.round(n * 10) / 10;

function streaks(days) {
  const runs = [];
  let run = null;
  for (const { date, count } of days) {
    if (count === 0) run = null;
    else if (run) (run.len++, (run.end = date));
    else runs.push((run = { len: 1, start: date, end: date }));
  }
  const longest = runs.reduce((a, b) => (b.len > a.len ? b : a), { len: 0 });
  // A quiet today doesn't break the streak until the day is over.
  const tail = runs.at(-1);
  const alive = tail && (tail.end === days.at(-1)?.date || tail.end === days.at(-2)?.date);
  return { current: alive ? tail : { len: 0 }, longest };
}

// The last 53 weeks as Sunday-first columns, like GitHub's own calendar.
function lastYear(days) {
  const counts = new Map(days.map((d) => [d.date, d.count]));
  const end = utc(days.at(-1).date);
  const start = new Date(end - (52 * 7 + end.getUTCDay()) * DAY);
  const cells = [];
  for (let i = 0, t = +start; t <= +end; i++, t += DAY) {
    const date = new Date(t).toISOString().slice(0, 10);
    cells.push({ date, count: counts.get(date) ?? 0, col: Math.floor(i / 7), row: i % 7 });
  }
  return cells;
}

const FONTS = `
  .mono { font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; }
  .sans { font-family: Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
  .serif { font-family: 'Instrument Serif', Georgia, 'Times New Roman', serif; font-style: italic; }
  .rise { animation: rise .9s cubic-bezier(.16, 1, .3, 1) both; }
  .fade { animation: fade .6s ease-out both; }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
  @keyframes fade { from { opacity: 0; } }`;

function card({ h, label, meta, title, css = '', body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="title">
<title id="title">${esc(title)}</title>
<style>${FONTS}${css}</style>
<defs>
  <radialGradient id="glow" cx="1" cy="0" r="1">
    <stop offset="0" stop-color="${C.ember}" stop-opacity=".14"/>
    <stop offset=".55" stop-color="${C.ember}" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect x=".5" y=".5" width="${W - 1}" height="${h - 1}" rx="16" fill="${C.bg}" stroke="${C.line}"/>
<rect x=".5" y=".5" width="${W - 1}" height="${h - 1}" rx="16" fill="url(#glow)"/>
<circle cx="${PAD + 4}" cy="38" r="3.5" fill="${C.ember}"/>
<text x="${PAD + 16}" y="42" class="mono" font-size="12" letter-spacing="2" fill="${C.muted}">${esc(label)}</text>
<text x="${W - PAD}" y="42" class="mono" font-size="12" fill="${C.subtle}" text-anchor="end">${esc(meta)}</text>
${body}
</svg>
`;
}

// ---------------------------------------------------------------- cards

function overview(d) {
  const { current, longest } = streaks(d.days);
  const updated = d.generatedAt.slice(0, 10);

  // Weekly totals for the sparkline.
  const recent = d.days.slice(-364);
  const weeks = Array.from({ length: Math.ceil(recent.length / 7) }, (_, i) =>
    recent.slice(i * 7, i * 7 + 7).reduce((n, x) => n + x.count, 0),
  );
  const peak = Math.max(1, ...weeks);
  const sx = 330, sw = 240, base = 142, sh = 62;
  const pts = weeks.map((v, i) => [r1(sx + (i * sw) / Math.max(1, weeks.length - 1)), r1(base - (v / peak) * sh)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  const area = `${line} L${sx + sw} ${base} L${sx} ${base} Z`;

  // Streak ring: current streak as a share of the longest.
  const rx = 640, ry = 112, rr = 34, circ = 2 * Math.PI * rr;
  const share = longest.len ? current.len / longest.len : 0;

  const tiles = [
    ['ALL-TIME', fmt(d.allTime), `contributions since ${d.since}`],
    ['COMMITS', fmt(d.year.commits), 'last 12 months'],
    ['PULL REQUESTS', fmt(d.year.prs), 'last 12 months'],
    ['CODE REVIEWS', fmt(d.year.reviews), 'last 12 months'],
    ['REPOSITORIES', fmt(d.repos), `${fmt(d.ownedRepos)} owned · ${fmt(d.stars)} stars`],
  ];
  const gap = 12, ty = 196, th = 88;
  const tw = (W - PAD * 2 - gap * (tiles.length - 1)) / tiles.length;

  const body = `
<g class="rise">
  <text x="${PAD}" y="128" class="sans" font-size="60" font-weight="600" letter-spacing="-2" fill="${C.fg}">${fmt(d.year.total)}</text>
  <text x="${PAD + 2}" y="158" class="mono" font-size="12" letter-spacing="2" fill="${C.muted}">CONTRIBUTIONS · 12 MONTHS</text>
</g>
<g class="fade" style="animation-delay:.2s">
  <path d="${area}" fill="url(#spark)"/>
  <path class="draw" d="${line}" fill="none" stroke="${C.ember}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>
  <line x1="${sx}" y1="${base + 0.5}" x2="${sx + sw}" y2="${base + 0.5}" stroke="${C.line}"/>
  <text x="${sx}" y="${base + 18}" class="mono" font-size="10" letter-spacing="1" fill="${C.subtle}">WEEKLY</text>
  <text x="${sx + sw}" y="${base + 18}" class="mono" font-size="10" letter-spacing="1" fill="${C.subtle}" text-anchor="end">PEAK ${fmt(peak)}/WK</text>
</g>
<line x1="${rx - 56}" y1="78" x2="${rx - 56}" y2="160" stroke="${C.line}"/>
<g class="rise" style="animation-delay:.3s">
  <circle cx="${rx}" cy="${ry}" r="${rr}" fill="none" stroke="${C.tile}" stroke-width="6"/>
  <circle class="ring" cx="${rx}" cy="${ry}" r="${rr}" fill="none" stroke="${C.ember}" stroke-width="6" stroke-linecap="round"
    stroke-dasharray="${r1(circ)}" stroke-dashoffset="${r1(circ * (1 - share))}" transform="rotate(-90 ${rx} ${ry})"/>
  <text x="${rx}" y="${ry + 9}" class="sans" font-size="26" font-weight="600" fill="${C.fg}" text-anchor="middle">${current.len}</text>
  <text x="${rx + 52}" y="${ry - 12}" class="mono" font-size="12" letter-spacing="2" fill="${C.ember}">DAY STREAK</text>
  <text x="${rx + 52}" y="${ry + 10}" class="sans" font-size="13" fill="${C.muted}">${current.len ? `${shortDate(current.start)} – ${shortDate(current.end)}` : 'Fresh start today'}</text>
  <text x="${rx + 52}" y="${ry + 30}" class="sans" font-size="13" fill="${C.subtle}">Longest · <tspan fill="${C.fg}">${longest.len} days</tspan></text>
</g>
${tiles
  .map(([label, value, sub], i) => {
    const x = r1(PAD + i * (tw + gap));
    return `<g class="rise" style="animation-delay:${0.4 + i * 0.07}s">
  <rect x="${x}" y="${ty}" width="${r1(tw)}" height="${th}" rx="12" fill="${C.tile}" stroke="${C.line}"/>
  <text x="${x + 16}" y="${ty + 26}" class="mono" font-size="10.5" letter-spacing="1.5" fill="${C.subtle}">${label}</text>
  <text x="${x + 16}" y="${ty + 58}" class="sans" font-size="26" font-weight="600" fill="${C.fg}">${value}</text>
  <text x="${x + 16}" y="${ty + 76}" class="sans" font-size="11" fill="${C.subtle}">${esc(sub)}</text>
</g>`;
  })
  .join('\n')}`;

  return card({
    h: ty + th + PAD,
    label: 'GITHUB · OVERVIEW',
    meta: `@${d.login} · updated ${updated}`,
    title: `GitHub overview for @${d.login}: ${fmt(d.year.total)} contributions in the last year, ${current.len}-day current streak`,
    css: `
  .draw { stroke-dasharray: 1; animation: draw 1.6s cubic-bezier(.16, 1, .3, 1) .3s both; }
  .ring { animation: ring 1.4s cubic-bezier(.16, 1, .3, 1) .5s both; }
  @keyframes draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
  @keyframes ring { from { stroke-dashoffset: ${r1(circ)}; } }`,
    body: `<defs><linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="${C.ember}" stop-opacity=".28"/><stop offset="1" stop-color="${C.ember}" stop-opacity="0"/>
</linearGradient></defs>${body}`,
  });
}

function contributions(d) {
  const cells = lastYear(d.days);
  const total = cells.reduce((n, c) => n + c.count, 0);
  const active = cells.filter((c) => c.count > 0);
  const sorted = active.map((c) => c.count).sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  const level = (n) => (n === 0 ? 0 : n <= q1 ? 1 : n <= q2 ? 2 : n <= q3 ? 3 : 4);

  const best = cells.reduce((a, b) => (b.count > a.count ? b : a), cells[0]);
  const byWeekday = Array(7).fill(0);
  for (const c of cells) byWeekday[c.row] += c.count;
  const busiest = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][byWeekday.indexOf(Math.max(...byWeekday))];

  const gx = PAD + 34, gy = 96;
  const pitch = (W - PAD - gx) / 53, size = pitch - 3.2;
  const xOf = (col) => r1(gx + col * pitch);

  const months = [];
  for (const c of cells) {
    const day = utc(c.date);
    if (c.row === 0 && day.getUTCDate() <= 7 && c.col < 51) {
      months.push(`<text x="${xOf(c.col)}" y="${gy - 12}" class="mono" font-size="10.5" fill="${C.subtle}">${day.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</text>`);
    }
  }

  const last = cells.at(-1);
  const grid = cells
    .map(
      (c) =>
        `<rect x="${xOf(c.col)}" y="${r1(gy + c.row * pitch)}" width="${r1(size)}" height="${r1(size)}" rx="2.5" fill="${HEAT[level(c.count)]}" style="animation-delay:${c.col * 14}ms"><title>${c.count} on ${shortDate(c.date)}</title></rect>`,
    )
    .join('\n');

  const fy = r1(gy + 7 * pitch + 30);
  const legendX = W - PAD - 5 * 15 - 34;
  const h = fy + 24;

  return card({
    h,
    label: 'CONTRIBUTIONS · LAST 12 MONTHS',
    meta: `${fmt(total)} total`,
    title: `Contribution calendar for @${d.login}: ${fmt(total)} contributions in the last 12 months`,
    css: `
  .cells rect { animation: fade .5s ease-out both; }
  .today { animation: pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 50% { stroke-opacity: .15; } }`,
    body: `
${months.join('\n')}
${['Mon', 'Wed', 'Fri'].map((t, i) => `<text x="${PAD}" y="${r1(gy + (i * 2 + 1) * pitch + size - 2)}" class="mono" font-size="10.5" fill="${C.subtle}">${t}</text>`).join('\n')}
<g class="cells">
${grid}
</g>
<rect class="today" x="${r1(xOf(last.col) - 2)}" y="${r1(gy + last.row * pitch - 2)}" width="${r1(size + 4)}" height="${r1(size + 4)}" rx="4" fill="none" stroke="${C.ember}" stroke-width="1.5"/>
<text x="${PAD}" y="${fy}" class="mono" font-size="11" letter-spacing="1.5" fill="${C.subtle}">ACTIVE DAYS <tspan fill="${C.fg}">${active.length}</tspan>   ·   BEST DAY <tspan fill="${C.fg}">${best.count}</tspan> <tspan fill="${C.faint}">(${shortDate(best.date).toUpperCase()})</tspan>   ·   BUSIEST <tspan fill="${C.fg}">${busiest}</tspan></text>
<text x="${legendX - 8}" y="${fy}" class="mono" font-size="10.5" fill="${C.subtle}" text-anchor="end">Less</text>
${HEAT.map((c, i) => `<rect x="${legendX + i * 15}" y="${fy - 10}" width="11" height="11" rx="2.5" fill="${c}"/>`).join('')}
<text x="${legendX + 5 * 15 + 4}" y="${fy}" class="mono" font-size="10.5" fill="${C.subtle}">More</text>`,
  });
}

function languages(d) {
  const MAX = 18;
  const all = d.languages.filter((l) => l.size > 0);
  const total = all.reduce((n, l) => n + l.size, 0) || 1;
  const shown = all.slice(0, MAX);
  const rest = all.slice(MAX).reduce((n, l) => n + l.size, 0);
  if (rest) shown.push({ name: 'Other', color: C.faint, size: rest });
  const pct = (l) => (100 * l.size) / total;
  const label = (p) => (p < 0.1 ? '<0.1%' : `${p < 10 ? p.toFixed(1) : Math.round(p)}%`);

  const bx = PAD, by = 74, bw = W - PAD * 2, bh = 12;
  let x = bx;
  const segments = shown
    .map((l) => {
      const w = (bw * l.size) / total;
      const seg = `<rect x="${r1(x)}" y="${by}" width="${r1(Math.max(w, 0.6))}" height="${bh}" fill="${l.color ?? C.faint}"/>`;
      x += w;
      return seg;
    })
    .join('');

  const cols = 3, colGap = 28, rowH = 36, ly = by + bh + 40;
  const cw = (bw - colGap * (cols - 1)) / cols;
  const rows = Math.ceil(shown.length / cols);
  const legend = shown
    .map((l, i) => {
      // Fill column by column so the biggest languages read top-down on the left.
      const col = Math.floor(i / rows), row = i % rows;
      const lx = r1(bx + col * (cw + colGap)), y = ly + row * rowH;
      return `<g class="rise" style="animation-delay:${0.25 + i * 0.04}s">
  <circle cx="${lx + 5}" cy="${y - 4}" r="5" fill="${l.color ?? C.faint}"/>
  <text x="${lx + 20}" y="${y}" class="sans" font-size="14" fill="${C.fg}">${esc(l.name)}</text>
  <text x="${r1(lx + cw)}" y="${y}" class="mono" font-size="12" fill="${C.muted}" text-anchor="end">${esc(label(pct(l)))}</text>
  <line x1="${lx}" y1="${y + 14.5}" x2="${r1(lx + cw)}" y2="${y + 14.5}" stroke="${C.line}"/>
</g>`;
    })
    .join('\n');

  const h = ly + rows * rowH + 8;
  return card({
    h,
    label: 'LANGUAGES · BY CODE VOLUME',
    meta: `${all.length} languages · ${fmt(d.ownedRepos)} repositories`,
    title: `Languages across @${d.login}'s repositories: ${shown.slice(0, 5).map((l) => `${l.name} ${label(pct(l))}`).join(', ')}`,
    body: `
<defs><clipPath id="bar"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6">
  <animate attributeName="width" from="0" to="${bw}" dur="1.4s" calcMode="spline" keyTimes="0;1" keySplines=".16 1 .3 1" fill="freeze"/>
</rect></clipPath></defs>
<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6" fill="${C.tile}"/>
<g clip-path="url(#bar)">${segments}</g>
${legend}`,
  });
}

// Platane/snk draws on a transparent canvas; give it the same dark card as the rest.
async function frameSnake(file) {
  if (!existsSync(file)) return;
  const svg = await readFile(file, 'utf8');
  const vb = svg.match(/viewBox="([-\d.\s]+)"/)?.[1].trim().split(/\s+/).map(Number);
  if (!vb || svg.includes('data-framed')) return;
  const [x, y, w, h] = vb;
  const bg = `<rect data-framed="" x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.bg}" stroke="${C.line}"/>`;
  await writeFile(file, svg.replace(/<svg[^>]*>/, (open) => open + bg));
}

// ---------------------------------------------------------------- main

const data = process.env.DATA_FILE ? JSON.parse(await readFile(process.env.DATA_FILE, 'utf8')) : await fetchData();
await mkdir(OUT, { recursive: true });
const cards = {
  'overview.svg': overview(data),
  'contributions.svg': contributions(data),
  'languages.svg': languages(data),
};
for (const [file, svg] of Object.entries(cards)) await writeFile(join(OUT, file), svg);
await frameSnake(join(OUT, 'snake.svg'));
console.log(`Rendered ${Object.keys(cards).join(', ')} for @${data.login} into ${OUT}/`);
