const WS_URL = 'ws://localhost:8000/ws/telemetry';
const MAX_POINTS = 24;
const HISTORY_SIZE = 30;

const machineDefinitions = [];
const machineById = new Map();
const MACHINE_ACTIONS = {
  M1_CNC_MILL: 'THROTTLE_DOWN',
  M2_HYDRAULIC_PRESS: 'DEPRESSURIZE_PARK',
  M3_VFD_CONVEYOR: 'REVERSE_CLEAR'
};
const MACHINE_TYPES = {
  M1_CNC_MILL: '5-Axis CNC Milling Center',
  M2_HYDRAULIC_PRESS: '200-Ton Hydraulic Press',
  M3_VFD_CONVEYOR: 'VFD Infeed Conveyor'
};
const MACHINE_FAULTS = {
  M1_CNC_MILL: { action: 'INJECT_BEARING_OVERHEAT', label: 'Inject Bearing Overheat' },
  M2_HYDRAULIC_PRESS: { action: 'INJECT_SEAL_RUPTURE', label: 'Inject Seal Rupture' },
  M3_VFD_CONVEYOR: { action: 'INJECT_BELT_JAM', label: 'Inject Belt Jam' }
};
const charts = new Map();
let socket = null;
let mockTimer = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let toastTimer = null;
let activeTransport = 'disconnected';
let editingMachineId = null;
const serviceStates = { watcher: 'stopped', ai_agent: 'stopped' };

const statusClasses = {
  OFFLINE: { badge: ['border-slate-700', 'bg-slate-800/50', 'text-slate-500'], row: 'border-l-slate-700', label: 'OFFLINE' },
  RUNNING: { badge: ['border-signal/30', 'bg-signal/10', 'text-signal'], row: 'border-l-signal/70', label: 'RUNNING' },
  CRITICAL: { badge: ['border-danger/30', 'bg-danger/10', 'text-danger'], row: 'border-l-danger/80', label: 'CRITICAL' }
};

function classifyStatus(status) {
  const value = String(status || 'RUNNING').toUpperCase();
  if (['OFFLINE', 'STOPPED', 'UNKNOWN'].includes(value)) return 'OFFLINE';
  if (value === 'CRITICAL') return 'CRITICAL';
  return 'RUNNING';
}

function primaryValue(machine) {
  return Number(machine.metrics?.[machine.primaryKey] ?? 0);
}

function formattedValue(value) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function machineFromRegistration(machineId, registration) {
  const fields = registration.fields || {};
  const keys = Object.keys(fields);
  return {
    machine_id: machineId,
    type: registration.type || MACHINE_TYPES[machineId] || machineId,
    manual_tag: registration.manual || '',
    fields,
    action: MACHINE_ACTIONS[machineId] || null,
    primaryKey: keys[0] || null,
    primaryLabel: keys[0] ? keys[0].replaceAll('_', ' ') : 'Telemetry',
    unit: keys[0] ? fields[keys[0]] : '',
    metrics: Object.fromEntries(keys.map((key) => [key, null])),
    flags: {},
    status: 'OFFLINE',
    processState: 'stopped',
    history: [],
    logs: ['Registered telemetry fields: ' + keys.join(', ')],
    lastSeen: false
  };
}

function loadMachineRegistry(registry) {
  const previousMachines = new Map(machineDefinitions.map((machine) => [machine.machine_id, machine]));
  charts.forEach((chart) => chart.destroy());
  charts.clear();
  machineDefinitions.splice(0, machineDefinitions.length);
  machineById.clear();
  Object.entries(registry || {}).forEach(([machineId, registration]) => {
    if (!registration || typeof registration !== 'object' || !registration.fields || typeof registration.fields !== 'object') return;
    const machine = machineFromRegistration(machineId, registration);
    const previous = previousMachines.get(machineId);
    if (previous) {
      machine.processState = previous.processState;
      machine.status = previous.status;
      machine.flags = previous.flags;
      machine.lastSeen = previous.lastSeen;
      machine.logs = previous.logs;
      machine.metrics = Object.fromEntries(Object.keys(machine.fields).map((key) => [key, previous.metrics[key] ?? null]));
      machine.history = previous.history.map((sample) => ({
        ...sample,
        metrics: Object.fromEntries(Object.keys(machine.fields).map((key) => [key, sample.metrics[key] ?? null]))
      }));
    }
    machineDefinitions.push(machine);
    machineById.set(machineId, machine);
  });
  buildMachineList();
  renderRegisteredMachineList();
}

function renderRegisteredMachineList() {
  const container = document.getElementById('registeredMachineList');
  if (!container) return;
  container.replaceChildren();
  if (machineDefinitions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'px-5 py-6 text-sm text-slate-500';
    empty.textContent = 'No registered machines.';
    container.append(empty);
    return;
  }

  machineDefinitions.forEach((machine) => {
    const row = document.createElement('div');
    row.className = 'flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between';
    const details = document.createElement('div');
    const id = document.createElement('div');
    id.className = 'font-mono text-xs text-slate-200';
    id.textContent = machine.machine_id;
    const metadata = document.createElement('div');
    metadata.className = 'mt-1 text-xs text-slate-500';
    metadata.textContent = `${machine.manual_tag} · ${Object.keys(machine.fields).length} fields · ${machine.processState === 'running' ? 'Running' : 'Stopped'}`;
    details.append(id, metadata);

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'inline-flex items-center gap-1.5 rounded border border-line px-3 py-2 text-xs text-slate-300 hover:border-signal/50 hover:text-signal';
    edit.append(makeIcon('pencil', 'h-3.5 w-3.5'), document.createTextNode('Edit'));
    edit.addEventListener('click', () => beginEditMachine(machine.machine_id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.disabled = machine.processState === 'running';
    remove.className = 'inline-flex items-center gap-1.5 rounded border border-danger/20 px-3 py-2 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40';
    remove.append(makeIcon('trash-2', 'h-3.5 w-3.5'), document.createTextNode('Delete'));
    remove.title = remove.disabled ? 'Stop this machine before deleting it' : 'Delete registration';
    remove.addEventListener('click', () => deleteMachineRegistration(machine.machine_id));
    actions.append(edit, remove);
    row.append(details, actions);
    container.append(row);
  });
  if (window.lucide) window.lucide.createIcons();
}

function addLog(machine, message, tone = 'normal') {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  machine.logs.push({ stamp, message, tone });
  if (machine.logs.length > HISTORY_SIZE) machine.logs.shift();
  renderLogs(machine);
}

function makeCell(className, text) {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function buildMachineRow(machine, index) {
  const row = document.createElement('tr');
  row.id = `machine-row-${machine.machine_id}`;
  row.dataset.machineId = machine.machine_id;
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-expanded', 'false');
  row.className = 'machine-row cursor-pointer border-l-2 border-l-signal/70 bg-panel transition hover:bg-white/[0.035]';
  row.append(makeCell('px-4 py-4 font-mono text-xs text-slate-600 sm:px-5', String(index + 1).padStart(2, '0')));

  const idCell = document.createElement('td');
  idCell.className = 'px-4 py-4';
  const idText = document.createElement('div');
  idText.className = 'font-mono text-xs font-medium text-slate-200';
  idText.textContent = machine.machine_id;
  const typeText = document.createElement('div');
  typeText.className = 'mt-1 text-[11px] text-slate-600';
  typeText.textContent = machine.manual_tag;
  idCell.append(idText, typeText);
  row.append(idCell);
  row.append(makeCell('px-4 py-4 text-xs text-slate-400', machine.type));

  const statusCell = document.createElement('td');
  statusCell.className = 'px-4 py-4';
  const badge = document.createElement('span');
  badge.id = `status-${machine.machine_id}`;
  badge.className = 'status-badge inline-flex items-center gap-2 rounded border px-2 py-1 font-mono text-[9px] font-medium tracking-wider';
  const dot = document.createElement('span');
  dot.className = 'status-dot h-1.5 w-1.5 rounded-full bg-current';
  const label = document.createElement('span');
  label.className = 'status-label';
  badge.append(dot, label);
  statusCell.append(badge);
  row.append(statusCell);

  const expandCell = document.createElement('td');
  expandCell.className = 'px-4 py-4 text-right';
  const expandIcon = document.createElement('i');
  expandIcon.dataset.lucide = 'chevron-down';
  expandIcon.className = 'expand-icon inline-block h-4 w-4 text-slate-600 transition-transform';
  expandCell.append(expandIcon);
  row.append(expandCell);

  const detailRow = document.createElement('tr');
  detailRow.id = `detail-row-${machine.machine_id}`;
  detailRow.className = 'hidden bg-[#0d1316]';
  const detailCell = document.createElement('td');
  detailCell.colSpan = 5;
  detailCell.className = 'border-t border-line p-4 sm:p-5';
  detailCell.append(buildMachineDetail(machine));
  detailRow.append(detailCell);

  const toggle = () => toggleMachineDetail(machine.machine_id);
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
  return [row, detailRow];
}

function buildMetricTile(machine, key, label, unit) {
  const tile = document.createElement('div');
  tile.id = `metric-tile-${machine.machine_id}-${key}`;
  tile.className = 'rounded border border-line bg-panel px-3 py-3';
  const title = document.createElement('div');
  title.className = 'text-[10px] uppercase tracking-wider text-slate-600';
  title.textContent = label;
  const value = document.createElement('div');
  value.id = `metric-${machine.machine_id}-${key}`;
  value.className = 'mono-data mt-2 text-lg text-slate-200';
  value.textContent = machine.lastSeen ? formattedValue(machine.metrics[key]) : '—';
  const units = document.createElement('span');
  units.className = 'ml-1 text-[10px] text-slate-600';
  units.textContent = unit;
  value.append(units);
  tile.append(title, value);
  return tile;
}

function buildMachineDetail(machine) {
  const wrapper = document.createElement('div');
  wrapper.className = 'grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]';

  const telemetry = document.createElement('div');
  telemetry.className = 'space-y-3';
  const metricGrid = document.createElement('div');
  metricGrid.className = 'grid grid-cols-2 gap-2 xl:grid-cols-4';
  const definitions = Object.entries(machine.metrics).map(([key]) => metricDefinition(machine.machine_id, key));
  definitions.forEach(([key, label, unit]) => metricGrid.append(buildMetricTile(machine, key, label, unit)));
  telemetry.append(metricGrid);

  const chartGrid = document.createElement('div');
  chartGrid.className = 'grid gap-3 md:grid-cols-2';
  chartGrid.id = `charts-${machine.machine_id}`;
  definitions.forEach(([key, label, unit]) => {
    const chartPanel = document.createElement('div');
    chartPanel.className = 'rounded border border-line bg-panel p-3';
    const chartHeading = document.createElement('div');
    chartHeading.className = 'mb-2 flex items-center justify-between';
    const chartTitle = document.createElement('span');
    chartTitle.className = 'text-xs font-medium text-slate-300';
    chartTitle.textContent = `${label} · ${unit}`;
    const chartValue = document.createElement('span');
    chartValue.id = `chart-value-${machine.machine_id}-${key}`;
    chartValue.className = 'mono-data text-[10px] text-slate-500';
    chartValue.textContent = '—';
    chartHeading.append(chartTitle, chartValue);
    const chartWrap = document.createElement('div');
    chartWrap.className = 'chart-wrap';
    const canvas = document.createElement('canvas');
    canvas.id = chartCanvasId(machine.machine_id, key);
    canvas.setAttribute('aria-label', `${label} live chart`);
    chartWrap.append(canvas);
    chartPanel.append(chartHeading, chartWrap);
    chartGrid.append(chartPanel);
  });
  telemetry.append(chartGrid);

  const rightColumn = document.createElement('div');
  rightColumn.className = 'space-y-3';
  const logPanel = document.createElement('div');
  logPanel.className = 'rounded border border-line bg-[#080c0e]';
  const logHeader = document.createElement('div');
  logHeader.className = 'flex items-center justify-between border-b border-line px-3 py-2';
  const logTitle = document.createElement('span');
  logTitle.className = 'flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-500';
  const terminalIcon = document.createElement('i');
  terminalIcon.dataset.lucide = 'terminal-square';
  terminalIcon.className = 'h-3.5 w-3.5';
  logTitle.append(terminalIcon, document.createTextNode('Agent Event Log'));
  const logState = document.createElement('span');
  logState.className = 'font-mono text-[9px] text-slate-600';
  logState.textContent = 'STREAM';
  logHeader.append(logTitle, logState);
  const logs = document.createElement('div');
  logs.id = `logs-${machine.machine_id}`;
  logs.className = 'scrollbar-thin h-[168px] space-y-2 overflow-y-auto p-3 font-mono text-[10px]';
  logPanel.append(logHeader, logs);
  rightColumn.append(logPanel);

  wrapper.append(telemetry, rightColumn);
  return wrapper;
}

function makeIcon(name, className) {
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  icon.className = className;
  return icon;
}

function metricDefinition(machineId, key) {
  const machine = machineById.get(machineId);
  const label = key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  return [key, label, machine?.fields[key] || ''];
}

function chartCanvasId(machineId, fieldName) {
  const safe = (value) => encodeURIComponent(value).replaceAll('%', '_');
  return `chart-${safe(machineId)}-${safe(fieldName)}`;
}

function toggleMachineDetail(machineId) {
  const row = document.getElementById(`machine-row-${machineId}`);
  const detail = document.getElementById(`detail-row-${machineId}`);
  const isOpen = !detail.classList.contains('hidden');
  detail.classList.toggle('hidden', isOpen);
  row.setAttribute('aria-expanded', String(!isOpen));
  row.querySelector('.expand-icon')?.classList.toggle('rotate-180', !isOpen);
  if (!isOpen) requestAnimationFrame(() => ensureChart(machineId));
}

function ensureChart(machineId) {
  if (typeof Chart === 'undefined') return;
  const machine = machineById.get(machineId);
  if (!machine) return;
  const accent = classifyStatus(machine.status) === 'CRITICAL' ? '#ff6b64' : '#63e6be';
  Object.keys(machine.fields).forEach((fieldName) => {
    const chartKey = `${machineId}:${fieldName}`;
    if (charts.has(chartKey)) return;
    const canvas = document.getElementById(chartCanvasId(machineId, fieldName));
    if (!canvas) return;
    const points = machine.history.slice(-MAX_POINTS);
    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: points.map((point) => point.label),
        datasets: [{
          data: points.map((point) => point.metrics[fieldName]),
          borderColor: accent,
          backgroundColor: `${accent}18`,
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 8,
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { intersect: false, mode: 'index' } },
        scales: {
          x: { display: true, grid: { color: 'rgba(148,163,184,.07)' }, ticks: { color: '#64748b', maxTicksLimit: 6, font: { family: 'DM Mono', size: 9 } } },
          y: { display: true, grid: { color: 'rgba(148,163,184,.07)' }, ticks: { color: '#64748b', maxTicksLimit: 5, font: { family: 'DM Mono', size: 9 } } }
        }
      }
    });
    charts.set(chartKey, chart);
  });
}

function updateChart(machine) {
  const last = machine.history[machine.history.length - 1];
  const state = classifyStatus(machine.status);
  const color = state === 'CRITICAL' ? '#ff6b64' : '#63e6be';
  Object.keys(machine.fields).forEach((fieldName) => {
    const chart = charts.get(`${machine.machine_id}:${fieldName}`);
    if (chart) {
      chart.data.labels.push(last.label);
      chart.data.datasets[0].data.push(last.metrics[fieldName]);
      if (chart.data.labels.length > MAX_POINTS) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
      }
      chart.data.datasets[0].borderColor = color;
      chart.data.datasets[0].backgroundColor = `${color}18`;
      chart.update('none');
    }
    const currentValue = document.getElementById(`chart-value-${machine.machine_id}-${fieldName}`);
    if (currentValue) currentValue.textContent = formattedValue(last.metrics[fieldName]);
  });
}

function renderLogs(machine) {
  const container = document.getElementById(`logs-${machine.machine_id}`);
  if (!container) return;
  const fragment = document.createDocumentFragment();
  machine.logs.slice(-8).forEach((entry) => {
    const line = document.createElement('div');
    line.className = 'flex gap-2';
    const stamp = document.createElement('span');
    stamp.className = 'shrink-0 text-slate-600';
    const message = typeof entry === 'string' ? entry : entry.message;
    stamp.textContent = typeof entry === 'string' ? '--:--:--' : entry.stamp;
    const text = document.createElement('span');
    const tone = typeof entry === 'string' ? 'normal' : entry.tone;
    text.className = tone === 'critical' ? 'text-danger' : tone === 'warning' ? 'text-amber' : 'text-slate-400';
    text.textContent = message;
    line.append(stamp, text);
    fragment.append(line);
  });
  container.replaceChildren(fragment);
  container.scrollTop = container.scrollHeight;
}

function setStatus(machine, rawStatus) {
  const previous = classifyStatus(machine.status);
  machine.status = rawStatus || 'RUNNING';
  const state = classifyStatus(machine.status);
  const config = statusClasses[state];
  const row = document.getElementById(`machine-row-${machine.machine_id}`);
  const badge = document.getElementById(`status-${machine.machine_id}`);
  if (row) {
    row.classList.remove('border-l-slate-700', 'border-l-signal/70', 'border-l-amber/80', 'border-l-danger/80');
    row.classList.add(config.row);
  }
  if (badge) {
    badge.classList.remove(...Object.values(statusClasses).flatMap((item) => item.badge));
    badge.classList.add(...config.badge);
    const label = badge.querySelector('.status-label');
    if (label) label.textContent = config.label;
  }
  const demoStatus = document.getElementById(`demo-status-${machine.machine_id}`);
  if (demoStatus) {
    demoStatus.classList.remove('text-signal', 'text-amber', 'text-danger');
    demoStatus.classList.add(state === 'OFFLINE' ? 'text-slate-500' : state === 'RUNNING' ? 'text-signal' : 'text-danger');
    const demoLabel = demoStatus.querySelector('span:last-child');
    if (demoLabel) demoLabel.textContent = config.label;
  }
  if (previous !== state) {
    const labels = { OFFLINE: 'Machine offline; waiting for telemetry.', RUNNING: 'Machine operating; no validated limit violation.', CRITICAL: 'Operational limit violation validated.' };
    addLog(machine, labels[state], state === 'CRITICAL' ? 'critical' : state === 'OFFLINE' ? 'warning' : 'normal');
  }
  updateKpis();
}

function updateKpis() {
  let healthy = 0;
  let critical = 0;
  machineDefinitions.forEach((machine) => {
    const state = classifyStatus(machine.status);
    if (state === 'RUNNING') healthy += 1;
    else if (state === 'CRITICAL') critical += 1;
  });
  setText('kpiTotal', String(machineDefinitions.length).padStart(2, '0'));
  setText('kpiHealthy', String(healthy).padStart(2, '0'));
  setText('kpiCritical', String(critical).padStart(2, '0'));
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function handleTelemetry(payload) {
  const machineId = payload?.machine_id;
  const machine = machineById.get(machineId);
  if (!machine || !payload.metrics || typeof payload.metrics !== 'object') return;
  if (activeTransport === 'websocket') document.getElementById('transportLabel').textContent = 'LIVE TELEMETRY';
  const priorFlags = machine.flags || {};
  const monitoredMetrics = Object.fromEntries(
    Object.entries(payload.metrics).filter(([key]) => Object.hasOwn(machine.fields, key))
  );
  if (Object.keys(monitoredMetrics).length === 0) return;
  machine.lastSeen = true;
  machine.metrics = { ...machine.metrics, ...monitoredMetrics };
  machine.flags = payload.flags || {};
  const assessment = payload.operational_assessment || {};
  const validatedAnomalies = assessment.validated === true && Array.isArray(payload.validated_anomalies)
    ? payload.validated_anomalies
    : [];
  const newStatus = validatedAnomalies.length > 0 ? 'CRITICAL' : 'RUNNING';

  Object.entries(machine.metrics).forEach(([key, value]) => {
    const span = document.getElementById(`metric-${machine.machine_id}-${key}`);
    const tile = document.getElementById(`metric-tile-${machine.machine_id}-${key}`);
    const anomalous = validatedAnomalies.some((issue) => issue.field === key);
    if (tile) {
      tile.classList.toggle('border-danger/60', anomalous);
      tile.classList.toggle('bg-danger/5', anomalous);
    }
    if (span) {
      const unit = span.querySelector('span');
      const text = formattedValue(value);
      span.firstChild.textContent = text;
      if (unit) span.append(unit);
    }
  });

  const flagNames = Object.keys(machine.flags).filter((key) => machine.flags[key] === true);
  const newlyRaised = flagNames.filter((key) => priorFlags[key] !== true);
  newlyRaised.forEach((flag) => addLog(machine, `${flag.replaceAll('_', ' ')} reported; checking operating limits.`, 'warning'));
  validatedAnomalies.forEach((issue) => {
    addLog(machine, `Validated: ${issue.field} ${issue.reason} (${issue.value}; ${issue.source}).`, 'critical');
  });
  if (newStatus !== machine.status) setStatus(machine, newStatus);
  else updateKpis();

  const value = primaryValue(machine);
  machine.history.push({
    label: new Date(payload.timestamp || Date.now()).toLocaleTimeString([], { hour12: false }),
    metrics: { ...machine.metrics }
  });
  if (machine.history.length > MAX_POINTS) machine.history.shift();
  updateChart(machine);
  const tableValue = document.getElementById(`primary-${machine.machine_id}`);
  if (tableValue) tableValue.textContent = `${formattedValue(value)} ${machine.unit}`;
  if (flagNames.length > 0 && newlyRaised.length > 0) {
    addLog(machine, `Diagnosing ${machine.type.toLowerCase()} anomaly...`, 'warning');
  }
}

function buildMachineList() {
  const tbody = document.getElementById('machineRows');
  const demoGrid = document.getElementById('demoMachineGrid');
  tbody.replaceChildren();
  demoGrid.replaceChildren();
  if (machineDefinitions.length === 0) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = 5;
    emptyCell.className = 'px-5 py-10 text-center text-sm text-slate-500';
    emptyCell.textContent = 'No machines registered.';
    emptyRow.append(emptyCell);
    tbody.append(emptyRow);
    const emptyState = document.createElement('p');
    emptyState.className = 'rounded-md border border-dashed border-line px-5 py-10 text-center text-sm text-slate-500 lg:col-span-3';
    emptyState.textContent = 'Register a machine to enable its simulator controls.';
    demoGrid.append(emptyState);
  }
  machineDefinitions.forEach((machine, index) => {
    const [row, detail] = buildMachineRow(machine, index);
    const primaryCell = document.createElement('td');
    primaryCell.className = 'hidden';
    const primary = document.createElement('span');
    primary.id = `primary-${machine.machine_id}`;
    primary.textContent = machine.lastSeen ? `${formattedValue(primaryValue(machine))} ${machine.unit}` : '—';
    primaryCell.append(primary);
    row.insertBefore(primaryCell, row.lastElementChild);
    tbody.append(row, detail);
    demoGrid.append(buildDemoCard(machine));
    setStatus(machine, machine.status);
    renderLogs(machine);
  });
  updateKpis();
  if (window.lucide) window.lucide.createIcons();
}

function buildDemoCard(machine) {
  const card = document.createElement('article');
  card.className = 'rounded-md border border-line bg-panel';
  const header = document.createElement('div');
  header.className = 'border-b border-line p-4';
  const type = document.createElement('div');
  type.className = 'mb-2 font-mono text-[9px] uppercase tracking-[0.15em] text-slate-600';
  type.textContent = machine.type;
  const id = document.createElement('h2');
  id.className = 'text-sm font-semibold text-white';
  id.textContent = machine.machine_id;
  const status = document.createElement('div');
  status.id = `demo-status-${machine.machine_id}`;
  status.className = 'mt-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-signal';
  const statusDot = document.createElement('span');
  statusDot.className = 'h-1.5 w-1.5 rounded-full bg-current';
  const statusText = document.createElement('span');
  statusText.textContent = 'RUNNING';
  status.append(statusDot, statusText);
  header.append(type, id, status);

  const actions = document.createElement('div');
  actions.className = 'space-y-2 p-4';
  const processButton = document.createElement('button');
  processButton.type = 'button';
  processButton.id = `process-${machine.machine_id}`;
  processButton.disabled = serviceStates.watcher !== 'running' || !machine.action;
  processButton.className = 'flex min-h-11 w-full items-center justify-center gap-2 rounded border border-signal/30 bg-signal/10 px-3 py-2 text-xs font-medium text-signal transition hover:bg-signal/20 disabled:cursor-not-allowed disabled:opacity-40';
  processButton.append(makeIcon('play', 'h-4 w-4'), document.createElement('span'));
  processButton.lastElementChild.textContent = machine.action ? 'Start Machine' : 'No simulator driver';
  processButton.addEventListener('click', () => toggleMachineProcess(machine.machine_id));
  actions.append(processButton);

  const fault = MACHINE_FAULTS[machine.machine_id];
  if (fault) {
    const faultButton = document.createElement('button');
    faultButton.type = 'button';
    faultButton.id = `fault-${machine.machine_id}`;
    faultButton.disabled = true;
    faultButton.className = 'flex min-h-11 w-full items-center justify-center gap-2 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-40';
    faultButton.append(makeIcon('triangle-alert', 'h-4 w-4'), document.createTextNode(fault.label));
    faultButton.addEventListener('click', () => sendControlCommand(machine.machine_id, fault.action));
    actions.append(faultButton);
  }
  card.append(header, actions);
  return card;
}

function updateMachineProcessState(machineId, state, message = '') {
  const machine = machineById.get(machineId);
  const button = document.getElementById(`process-${machineId}`);
  if (!machine || !button) return;
  machine.processState = state;
  const label = button.querySelector('span');
  const running = state === 'running';
  const pending = state === 'starting' || state === 'stopping';
  button.disabled = pending || serviceStates.watcher !== 'running' || !machine.action;
  button.className = `flex min-h-11 w-full items-center justify-center gap-2 rounded border px-3 py-2 text-xs font-medium transition disabled:cursor-wait disabled:opacity-60 ${running ? 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/20' : 'border-signal/30 bg-signal/10 text-signal hover:bg-signal/20'}`;
  button.firstElementChild.dataset.lucide = running ? 'square' : 'play';
  if (label) label.textContent = !machine.action ? 'No simulator driver' : pending ? (state === 'starting' ? 'Starting…' : 'Stopping…') : running ? 'Stop Machine' : state === 'error' ? 'Retry Start' : 'Start Machine';
  const faultButton = document.getElementById(`fault-${machineId}`);
  if (faultButton) faultButton.disabled = !running;
  if (state === 'stopped' || state === 'error') {
    machine.lastSeen = false;
    setStatus(machine, 'OFFLINE');
    Object.keys(machine.metrics).forEach((key) => {
      const value = document.getElementById(`metric-${machineId}-${key}`);
      if (value) value.firstChild.textContent = '—';
    });
    const primary = document.getElementById(`primary-${machineId}`);
    if (primary) primary.textContent = '—';
  }
  if (message) showToast(message, state === 'error' ? 'danger' : 'signal');
  if (window.lucide) window.lucide.createIcons();
}

function updateServiceState(service, state, message = '') {
  serviceStates[service] = state;
  const isWatcher = service === 'watcher';
  const button = document.getElementById(isWatcher ? 'watcherServiceButton' : 'agentServiceButton');
  const label = button?.querySelector('span');
  const detail = document.getElementById(isWatcher ? 'watcherServiceState' : 'agentServiceState');
  const running = state === 'running';
  const pending = state === 'starting' || state === 'stopping';
  if (button) {
    button.disabled = pending || (!isWatcher && serviceStates.watcher !== 'running' && !running);
    button.className = `inline-flex min-h-10 items-center justify-center gap-2 rounded border px-4 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${running ? 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/20' : 'border-signal/30 bg-signal/10 text-signal hover:bg-signal/20'}`;
    button.firstElementChild.dataset.lucide = running ? 'square' : 'play';
    if (label) label.textContent = pending ? (state === 'starting' ? 'Starting…' : 'Stopping…') : running ? (isWatcher ? 'Stop Watcher' : 'Stop AI Agent') : state === 'error' ? 'Retry Start' : (isWatcher ? 'Start Watcher' : 'Start AI Agent');
  }
  if (detail) {
    detail.textContent = message || (running ? (isWatcher ? 'Running · UDP 5005' : 'Running · watching for anomalies') : state === 'error' ? 'Error · check backend log' : 'Stopped');
    detail.className = `mt-1 text-xs ${state === 'error' ? 'text-danger' : running ? 'text-signal' : 'text-slate-500'}`;
  }
  if (isWatcher) {
    machineDefinitions.forEach((machine) => updateMachineProcessState(machine.machine_id, machine.processState));
    const agentButton = document.getElementById('agentServiceButton');
    if (agentButton && serviceStates.ai_agent !== 'running') {
      agentButton.disabled = state !== 'running';
    }
  }
  if (message) showToast(message, state === 'error' ? 'danger' : 'signal');
  if (window.lucide) window.lucide.createIcons();
}

function toggleService(service) {
  const action = serviceStates[service] === 'running' ? 'stop_service' : 'start_service';
  if (socket?.readyState !== WebSocket.OPEN) {
    showToast('Dashboard backend is offline.', 'danger');
    return;
  }
  updateServiceState(service, action === 'start_service' ? 'starting' : 'stopping');
  socket.send(JSON.stringify({ type: action, service, request_id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` }));
}

function toggleMachineProcess(machineId) {
  const machine = machineById.get(machineId);
  if (!machine) return;
  const action = machine.processState === 'running' ? 'stop_machine' : 'start_machine';
  if (socket?.readyState === WebSocket.OPEN) {
    updateMachineProcessState(machineId, action === 'start_machine' ? 'starting' : 'stopping');
    socket.send(JSON.stringify({ type: action, machine_id: machineId, request_id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` }));
    return;
  }
  showToast('Dashboard backend is offline.', 'danger');
}

function sendControlCommand(machineId, action, targetValue) {
  const command = { type: 'control', machine_id: machineId, action, target_value: targetValue ?? null, request_id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` };
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(command));
    addLog(machineById.get(machineId), `Control command sent: ${action}.`, 'warning');
    showToast(`Command sent to ${machineId}`, 'signal');
    return;
  }
  showToast('Dashboard backend is offline; command was not sent.', 'danger');
}

function showToast(message, tone = 'signal') {
  const toast = document.getElementById('toast');
  toast.className = `pointer-events-none fixed bottom-5 right-5 z-[70] flex items-center gap-2 rounded-md border px-4 py-3 text-sm shadow-xl transition-all duration-200 ${tone === 'amber' ? 'border-amber/40 bg-[#221d12] text-amber' : tone === 'danger' ? 'border-danger/40 bg-[#241615] text-danger' : 'border-signal/40 bg-[#11201d] text-signal'}`;
  toast.replaceChildren(makeIcon(tone === 'danger' ? 'triangle-alert' : 'circle-check', 'h-4 w-4'));
  toast.append(document.createTextNode(message));
  requestAnimationFrame(() => toast.classList.remove('translate-y-3', 'opacity-0'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('translate-y-3', 'opacity-0'), 2800);
  if (window.lucide) window.lucide.createIcons();
}

function routeTo(screenName) {
  document.querySelectorAll('[data-screen]').forEach((section) => section.classList.toggle('hidden', section.dataset.screen !== screenName));
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.dataset.route === screenName;
    link.classList.toggle('bg-signal/10', active);
    link.classList.toggle('text-signal', active);
    link.classList.toggle('text-slate-400', !active);
  });
  closeNavigation();
  if (screenName === 'live') charts.forEach((chart) => chart.resize());
}

function openNavigation() {
  document.getElementById('navDrawer').style.transform = 'translateX(0)';
  document.getElementById('drawerBackdrop').classList.remove('hidden');
  document.getElementById('menuButton').setAttribute('aria-expanded', 'true');
}

function closeNavigation() {
  document.getElementById('navDrawer').style.transform = 'translateX(-100%)';
  document.getElementById('drawerBackdrop').classList.add('hidden');
  document.getElementById('menuButton').setAttribute('aria-expanded', 'false');
}

function setTransport(state, label) {
  activeTransport = state;
  const dot = document.getElementById('headerConnectionDot');
  const text = document.getElementById('headerConnectionText');
  const feed = document.getElementById('transportLabel');
  dot.classList.remove('bg-signal', 'bg-amber', 'bg-danger');
  if (state === 'websocket') {
    dot.classList.add('bg-signal');
    text.textContent = 'WebSocket connected';
    feed.textContent = 'SOCKET READY';
    feed.className = 'font-mono text-[10px] uppercase tracking-wider text-signal';
  } else if (state === 'mock') {
    dot.classList.add('bg-amber');
    text.textContent = 'Mock telemetry';
    feed.textContent = label || 'MOCK FEED';
    feed.className = 'font-mono text-[10px] uppercase tracking-wider text-amber';
  } else {
    dot.classList.add('bg-danger');
    text.textContent = 'Backend offline';
    feed.textContent = label || 'BACKEND OFFLINE';
    feed.className = 'font-mono text-[10px] uppercase tracking-wider text-danger';
  }
}

function startMockFeed() {
  if (mockTimer) return;
  setTransport('mock', 'MOCK FEED');
  machineDefinitions.forEach((machine) => {
    addLog(machine, 'WebSocket unavailable; local simulation active.', 'warning');
  });
  mockTimer = setInterval(() => {
    machineDefinitions.forEach((machine) => {
      machine.phase += 0.17;
      const metrics = { ...machine.metrics };
      Object.entries(metrics).forEach(([key, value]) => {
        const base = machine.baselineMetrics[key];
        if (machine.status === 'RUNNING') {
          const amp = Math.max(Math.abs(base) * 0.006, 0.012);
          metrics[key] = base + Math.sin(machine.phase + key.length) * amp + (Math.random() - 0.5) * amp * 0.5;
        }
      });
      handleTelemetry({ machine_id: machine.machine_id, status: machine.status, metrics, flags: machine.flags, timestamp: new Date().toISOString() });
    });
  }, 500);
}

function stopMockFeed() {
  clearInterval(mockTimer);
  mockTimer = null;
}

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch (error) {
    scheduleReconnect();
    setTransport('disconnected', 'BACKEND OFFLINE');
    return;
  }
  socket.addEventListener('open', () => {
    reconnectDelay = 1000;
    stopMockFeed();
    setTransport('websocket');
    machineDefinitions.forEach((machine) => addLog(machine, 'WebSocket telemetry connected.', 'normal'));
  });
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'registry_snapshot') loadMachineRegistry(message.machines);
      else if (message.type === 'registration_result') {
        showToast(message.message || (message.accepted ? 'Registration saved.' : 'Registration failed.'), message.accepted ? 'signal' : 'danger');
        const savedRegistration = message.accepted && message.action !== 'delete';
        const deletedCurrentEdit = message.accepted && message.action === 'delete' && editingMachineId === message.machine_id;
        if (savedRegistration || deletedCurrentEdit) {
          document.getElementById('registrationForm').reset();
          document.getElementById('machineIdInput').disabled = false;
          document.querySelector('#registrationSubmitButton span').textContent = 'Register Machine';
          editingMachineId = null;
          document.getElementById('newTypeField').classList.add('hidden');
          document.getElementById('telemetryFieldRows').replaceChildren();
          addTelemetryFieldRow();
        }
      }
      else if (message.type === 'telemetry' && message.payload) handleTelemetry(message.payload);
      else if (message.type === 'service_state') {
        updateServiceState(message.service, message.state, message.message || '');
      }
      else if (message.type === 'machine_state') {
        updateMachineProcessState(message.machine_id, message.state, message.message || '');
      }
      else if (message.type === 'command_result') {
        const machine = machineById.get(message.machine_id);
        if (machine) addLog(machine, message.message || `Command ${message.accepted ? 'accepted' : 'rejected'}.`, message.accepted ? 'normal' : 'critical');
        showToast(message.message || `Command ${message.accepted ? 'accepted' : 'rejected'}`, message.accepted ? 'signal' : 'danger');
      } else handleTelemetry(message);
    } catch (error) {
      console.warn('Ignoring malformed telemetry message.', error);
    }
  });
  socket.addEventListener('error', () => socket?.close());
  socket.addEventListener('close', () => {
    socket = null;
    setTransport('disconnected', 'BACKEND OFFLINE');
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function startClock() {
  const update = () => {
    setText('currentTime', `${new Date().toISOString().slice(11, 19)} UTC`);
  };
  update();
  setInterval(update, 1000);
}

function addTelemetryFieldRow(fieldName = '', unit = '') {
  const rows = document.getElementById('telemetryFieldRows');
  const row = document.createElement('div');
  row.className = 'telemetry-field-row grid grid-cols-[minmax(0,1fr)_minmax(90px,140px)_40px] gap-2';
  const nameInput = document.createElement('input');
  nameInput.dataset.fieldName = 'true';
  nameInput.required = true;
  nameInput.value = fieldName;
  nameInput.placeholder = 'Telemetry key (e.g. bearing_temp_c)';
  nameInput.className = 'min-w-0 rounded-md border border-line bg-ink px-3 py-2.5 font-mono text-xs text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-700 focus:border-signal';
  const unitInput = document.createElement('input');
  unitInput.dataset.fieldUnit = 'true';
  unitInput.required = true;
  unitInput.value = unit;
  unitInput.placeholder = 'Unit';
  unitInput.className = 'min-w-0 rounded-md border border-line bg-ink px-3 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-700 focus:border-signal';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'grid h-10 w-10 place-items-center rounded border border-line text-slate-500 hover:border-danger/40 hover:text-danger';
  remove.setAttribute('aria-label', 'Remove telemetry field');
  remove.append(makeIcon('x', 'h-4 w-4'));
  remove.addEventListener('click', () => {
    row.remove();
    updateFieldRowRemoveButtons();
  });
  row.append(nameInput, unitInput, remove);
  rows.append(row);
  updateFieldRowRemoveButtons();
  if (window.lucide) window.lucide.createIcons();
}

function updateFieldRowRemoveButtons() {
  const rows = [...document.querySelectorAll('.telemetry-field-row')];
  rows.forEach((row) => {
    const remove = row.querySelector('button');
    remove.disabled = rows.length === 1;
    remove.classList.toggle('opacity-40', remove.disabled);
  });
}

function beginEditMachine(machineId) {
  const machine = machineById.get(machineId);
  if (!machine) return;
  editingMachineId = machineId;
  routeTo('registration');
  const machineIdInput = document.getElementById('machineIdInput');
  machineIdInput.value = machine.machine_id;
  machineIdInput.disabled = true;
  document.getElementById('manualIdInput').value = machine.manual_tag;
  const typeSelect = document.getElementById('machineTypeSelect');
  const knownType = [...typeSelect.options].some((option) => option.value === machine.type);
  typeSelect.value = knownType ? machine.type : '__new__';
  document.getElementById('newTypeInput').value = knownType ? '' : machine.type;
  document.getElementById('newTypeField').classList.toggle('hidden', knownType);
  const rows = document.getElementById('telemetryFieldRows');
  rows.replaceChildren();
  Object.entries(machine.fields).forEach(([field, unit]) => addTelemetryFieldRow(field, unit));
  document.querySelector('#registrationSubmitButton span').textContent = 'Save Changes';
  document.getElementById('machineIdInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function deleteMachineRegistration(machineId) {
  if (socket?.readyState !== WebSocket.OPEN) {
    showToast('Dashboard backend is offline.', 'danger');
    return;
  }
  if (!window.confirm(`Delete registration for ${machineId}?`)) return;
  socket.send(JSON.stringify({ type: 'delete_machine', machine_id: machineId }));
}

function wireRegistration() {
  const typeSelect = document.getElementById('machineTypeSelect');
  const newTypeField = document.getElementById('newTypeField');
  const fieldRows = document.getElementById('telemetryFieldRows');
  addTelemetryFieldRow();
  document.getElementById('addTelemetryFieldButton').addEventListener('click', () => addTelemetryFieldRow());
  typeSelect.addEventListener('change', () => newTypeField.classList.toggle('hidden', typeSelect.value !== '__new__'));
  document.getElementById('registrationForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const selectedType = typeSelect.value === '__new__' ? document.getElementById('newTypeInput').value.trim() : typeSelect.value;
    const file = document.getElementById('manualFileInput').files[0];
    if (file && !file.name.toLowerCase().endsWith('.pdf')) {
      showToast('Upload a PDF manual.', 'danger');
      return;
    }
    const fields = {};
    for (const row of fieldRows.querySelectorAll('.telemetry-field-row')) {
      const name = row.querySelector('[data-field-name]').value.trim();
      const unit = row.querySelector('[data-field-unit]').value.trim();
      if (!name || !unit || Object.hasOwn(fields, name)) {
        showToast('Enter a unique field name and unit for every row.', 'danger');
        return;
      }
      fields[name] = unit;
    }
    const machineType = selectedType === '__new__' ? document.getElementById('newTypeInput').value.trim() : selectedType;
    const registration = {
      machine_id: document.getElementById('machineIdInput').value.trim(),
      manual: document.getElementById('manualIdInput').value.trim(),
      machine_type: machineType,
      fields
    };
    if (!registration.machine_type) {
      showToast('Enter a machine type.', 'danger');
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN) {
      showToast('Connect to the dashboard backend before registering.', 'danger');
      return;
    }
    socket.send(JSON.stringify({ type: 'register_machine', ...registration }));
  });
}

function wireNavigation() {
  document.querySelectorAll('[data-route]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    routeTo(link.dataset.route);
  }));
  document.getElementById('menuButton').addEventListener('click', openNavigation);
  document.getElementById('closeDrawer').addEventListener('click', closeNavigation);
  document.getElementById('drawerBackdrop').addEventListener('click', closeNavigation);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNavigation();
  });
  document.getElementById('resetAllButton').addEventListener('click', () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'control', machine_id: '*', action: 'RESET_ALL', request_id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` }));
      showToast('RESET ALL command sent', 'amber');
    } else {
      showToast('Dashboard backend is offline; reset was not sent.', 'danger');
    }
  });
  document.getElementById('watcherServiceButton').addEventListener('click', () => toggleService('watcher'));
  document.getElementById('agentServiceButton').addEventListener('click', () => toggleService('ai_agent'));
}

function initialize() {
  buildMachineList();
  wireNavigation();
  wireRegistration();
  startClock();
  if (window.lucide) window.lucide.createIcons();
  connectWebSocket();
}

document.addEventListener('DOMContentLoaded', initialize);
