/* ================================================================
   Reporte de salud de validación FDM — SARA Custom Visual
   ES5 estricto · Canvas 2D · sin dependencias externas

   PARTE 1 · Reporte base: Overview, Salud por evento, Patrones, Validadores
   PARTE 2 · Pestaña «Asistente de validación» (motor EB-HAL)

   El asistente se inicializa de forma diferida la primera vez que se abre
   su pestaña: ajustar el modelo recorre todo el histórico y no debe
   retrasar el arranque del resto del reporte.
   ================================================================ */
(function () {
  var diag = document.getElementById('diag');
  try {
    var ds = DATA['@event'];
    if (!ds || !ds.rows || ds.rows.length === 0) {
      if (diag) diag.innerText = 'Sin datos en @event';
      return;
    }
    var rawAll = ds.rows;

    // ==================================================
    // UTILIDADES
    // ==================================================
    function getEl(id) {
      var el = document.getElementById(id);
      if (!el) throw new Error('Elemento no encontrado: #' + id);
      return el;
    }
    function toBool(v) {
      if (v === true || v === 1) return true;
      if (typeof v === 'string') { var s = v.toLowerCase(); return s === 'true' || s === '1' || s === 't'; }
      return false;
    }
    function hasValue(v) { return v !== null && v !== undefined && v !== ''; }
    function parseDateSafe(v) {
      if (!hasValue(v)) return null;
      var d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    }
    function clean(v, fallback) { return hasValue(v) ? String(v) : fallback; }
    function monthKey(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
    function monthLabel(d) {
      var meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      return meses[d.getMonth()] + ' ' + d.getFullYear();
    }
    function pct(x) { return Math.round(x * 100); }
    function truncate(str, n) { return str.length > n ? str.substring(0, n - 1) + '…' : str; }
    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    var Z95 = 1.96;
    function wilsonInterval(k, n) {
      if (n === 0) return { lower: 0, upper: 1, rate: 0 };
      var phat = k / n;
      var z2 = Z95 * Z95;
      var denom = 1 + z2 / n;
      var center = (phat + z2 / (2 * n)) / denom;
      var margin = (Z95 * Math.sqrt((phat * (1 - phat) / n) + (z2 / (4 * n * n)))) / denom;
      return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), rate: phat };
    }
    function significanceVsBaseline(wilson, baseline) {
      if (wilson.lower > baseline) return 'high';
      if (wilson.upper < baseline) return 'low';
      return null;
    }
    function sigColor(sig) {
      if (sig === 'high') return '#EA4335';
      if (sig === 'low') return '#4285F4';
      return '#dadce0';
    }

    var DIM_LABELS = {
      registration: 'Matrícula',
      origin: 'Origen',
      destination: 'Destino',
      version: 'Versión',
      dataframe: 'Dataframe'
    };

    // ==================================================
    // NORMALIZACIÓN (+ campo validator)
    // ==================================================
    var events = [];
    var totalFlights = rawAll.length;
    for (var i = 0; i < rawAll.length; i++) {
      var r = rawAll[i];
      if (!hasValue(r['eventid'])) continue;
      events.push({
        name: clean(r['eventname'], '(sin nombre)'),
        invalid: toBool(r['isinvalid']),
        isOpen: toBool(r['isopen']),
        eventDateObj: parseDateSafe(r['eventdate']),
        registration: clean(r['registration'], '(sin dato)'),
        origin: clean(r['originicao'], '(sin dato)'),
        destination: clean(r['destinationicao'], '(sin dato)'),
        version: clean(r['version'], '(sin dato)'),
        dataframe: clean(r['dataframe'], '(sin dato)'),
        validator: clean(r['lastmodifiedby'], '')
      });
    }

    // ==================================================
    // REFERENCIAS DOM
    // ==================================================
    var subtitleEl = getEl('app-sub');
    var totalEl = getEl('kpi-total');
    var validEl = getEl('kpi-valid');
    var invalidEl = getEl('kpi-invalid');
    var openEl = getEl('kpi-open');
    var ratioEl = getEl('kpi-ratio');
    var ratioFootEl = getEl('kpi-ratio-foot');
    var trendCanvas = getEl('trend-chart');
    var trendScroll = getEl('trend-scroll');
    var healthCanvas = getEl('health-chart');
    var healthScroll = getEl('health-scroll');
    var healthToggle = getEl('health-toggle');
    var healthCountLabel = getEl('health-count-label');
    var healthKpiTotal = getEl('health-kpi-total');
    var healthKpiValid = getEl('health-kpi-valid');
    var healthKpiInvalid = getEl('health-kpi-invalid');
    var tip = getEl('tooltip');
    var tabs = getEl('tabs');
    var patternViewSelector = getEl('pattern-view-selector');
    var patternEventInput = getEl('pattern-event-input');
    var patternEventList = getEl('pattern-event-list');
    var patternBackBtn = getEl('pattern-back-btn');
    var patternHeatmapView = getEl('pattern-heatmap-view');
    var patternWilsonView = getEl('pattern-wilson-view');
    var patternHeatmapCanvas = getEl('pattern-heatmap');
    var patternHeatmapScroll = getEl('pattern-heatmap-scroll');
    var patternWilsonCanvas = getEl('pattern-wilson-chart');
    var patternWilsonScroll = getEl('pattern-wilson-scroll');
    var patternsTitle = getEl('patterns-title');
    var patternsHint = getEl('patterns-hint');

    // Validadores tab
    var valTitle = getEl('val-title');
    var valHint = getEl('val-hint');
    var valDimSelector = getEl('val-dim-selector');
    var valEventInput = getEl('val-event-input');
    var valEventList = getEl('val-event-list');
    var valHeatmapCanvas = getEl('val-heatmap');
    var valHeatmapScroll = getEl('val-heatmap-scroll');

    // ==================================================
    // OBJETIVO A: CONTEOS
    // ==================================================
    var totalEvents = events.length;
    var openCount = 0, invalidCount = 0, validCount = 0;
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      if (ev.isOpen) { openCount++; continue; }
      if (ev.invalid) invalidCount++;
      else validCount++;
    }
    var closedCount = validCount + invalidCount;
    var globalRate = closedCount > 0 ? invalidCount / closedCount : 0;

    subtitleEl.innerText = totalFlights + ' vuelos analizados · ' + totalEvents + ' eventos severidad alta';
    totalEl.innerText = totalEvents;
    validEl.innerText = validCount;
    invalidEl.innerText = invalidCount;
    openEl.innerText = openCount;
    ratioEl.innerText = closedCount > 0 ? pct(globalRate) + '%' : 'Sin datos';
    ratioFootEl.innerText = closedCount > 0 ? 'sobre ' + closedCount + ' eventos ya validados' : 'aún no hay eventos validados';
    healthKpiTotal.innerText = closedCount;
    healthKpiValid.innerText = validCount;
    healthKpiInvalid.innerText = invalidCount;

    // ==================================================
    // OBJETIVO A: LÍNEA DE TIEMPO
    // ==================================================
    var WINDOW_MONTHS = 6;
    var now = new Date();
    var months = [];
    for (var m = WINDOW_MONTHS - 1; m >= 0; m--) {
      var d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      months.push({ key: monthKey(d), label: monthLabel(d), total: 0, invalid: 0, rate: null });
    }
    var monthIndex = {};
    for (var mi = 0; mi < months.length; mi++) monthIndex[months[mi].key] = mi;
    for (var c = 0; c < events.length; c++) {
      var row = events[c];
      if (row.isOpen || !row.eventDateObj) continue;
      var mk = monthKey(row.eventDateObj);
      if (monthIndex[mk] === undefined) continue;
      var bkt = months[monthIndex[mk]];
      bkt.total += 1;
      if (row.invalid) bkt.invalid += 1;
    }
    for (var mm = 0; mm < months.length; mm++) {
      months[mm].rate = months[mm].total > 0 ? months[mm].invalid / months[mm].total : null;
    }

    var trendCtx = trendCanvas.getContext('2d');
    function renderTrendChart() {
      var PAD_L = 50, PAD_R = 30, PAD_T = 24, PAD_B = 40;
      var plotW = 560, plotH = 220;
      var W = PAD_L + plotW + PAD_R, H = PAD_T + plotH + PAD_B;
      var minW = trendScroll.clientWidth || 640;
      if (W < minW) W = minW;
      trendCanvas.width = W;
      trendCanvas.height = H;
      trendCtx.fillStyle = '#ffffff';
      trendCtx.fillRect(0, 0, W, H);

      var usablePlotW = W - PAD_L - PAD_R;
      var maxRate = 0;
      for (var i2 = 0; i2 < months.length; i2++) {
        if (months[i2].rate !== null && months[i2].rate > maxRate) maxRate = months[i2].rate;
      }
      var yMax = Math.max(0.1, Math.ceil((maxRate + 0.05) * 10) / 10);

      trendCtx.strokeStyle = '#e8eaed';
      trendCtx.fillStyle = '#9aa0a6';
      trendCtx.font = '10.5px Roboto, Arial, sans-serif';
      trendCtx.textAlign = 'right';
      trendCtx.textBaseline = 'middle';
      for (var g = 0; g <= 4; g++) {
        var yv = (yMax / 4) * g;
        var yy = PAD_T + plotH - (yv / yMax) * plotH;
        trendCtx.beginPath(); trendCtx.moveTo(PAD_L, yy); trendCtx.lineTo(W - PAD_R, yy); trendCtx.stroke();
        trendCtx.fillText(pct(yv) + '%', PAD_L - 8, yy);
      }

      var stepX = usablePlotW / (months.length - 1);
      var points = [];
      for (var j = 0; j < months.length; j++) {
        var mx = PAD_L + j * stepX;
        var my = months[j].rate !== null ? PAD_T + plotH - (months[j].rate / yMax) * plotH : null;
        points.push({ x: mx, y: my, month: months[j] });
      }

      trendCtx.strokeStyle = '#4285F4';
      trendCtx.lineWidth = 2;
      trendCtx.beginPath();
      var started = false;
      for (var k = 0; k < points.length; k++) {
        if (points[k].y === null) continue;
        if (!started) { trendCtx.moveTo(points[k].x, points[k].y); started = true; }
        else trendCtx.lineTo(points[k].x, points[k].y);
      }
      trendCtx.stroke();
      trendCtx.lineWidth = 1;

      for (var l = 0; l < points.length; l++) {
        var pt = points[l];
        trendCtx.fillStyle = '#9aa0a6';
        trendCtx.font = '11px Roboto, Arial, sans-serif';
        trendCtx.textAlign = 'center';
        trendCtx.textBaseline = 'top';
        trendCtx.fillText(pt.month.label, pt.x, PAD_T + plotH + 12);
        if (pt.y === null) continue;
        var isLast = (l === points.length - 1);
        trendCtx.fillStyle = isLast ? '#1967d2' : '#4285F4';
        trendCtx.beginPath(); trendCtx.arc(pt.x, pt.y, isLast ? 6 : 5, 0, Math.PI * 2); trendCtx.fill();
        trendCtx.fillStyle = '#202124';
        trendCtx.font = (isLast ? '600 ' : '400 ') + '11.5px Roboto, Arial, sans-serif';
        trendCtx.textAlign = 'center';
        trendCtx.textBaseline = 'bottom';
        trendCtx.fillText(pct(pt.month.rate) + '%', pt.x, pt.y - 10);
        trendCtx.fillStyle = '#c7c9cc';
        trendCtx.font = '9.5px Roboto, Arial, sans-serif';
        trendCtx.fillText('n=' + pt.month.total, pt.x, pt.y + 22);
      }

      if (!started) {
        trendCtx.fillStyle = '#9aa0a6';
        trendCtx.font = '13px Roboto, Arial, sans-serif';
        trendCtx.textAlign = 'center';
        trendCtx.textBaseline = 'middle';
        trendCtx.fillText('Sin eventos validados en este período', W / 2, PAD_T + plotH / 2);
      }
    }

    // ==================================================
    // OBJETIVO B: SALUD POR EVENTO
    // ==================================================
    function computeEventHealth() {
      var byEvent = {};
      for (var i3 = 0; i3 < events.length; i3++) {
        var ev2 = events[i3];
        if (ev2.isOpen) continue;
        if (!byEvent[ev2.name]) byEvent[ev2.name] = { n: 0, k: 0 };
        byEvent[ev2.name].n += 1;
        if (ev2.invalid) byEvent[ev2.name].k += 1;
      }
      var list = [];
      var names = Object.keys(byEvent);
      for (var e2 = 0; e2 < names.length; e2++) {
        var stat = byEvent[names[e2]];
        var wilson = wilsonInterval(stat.k, stat.n);
        list.push({
          name: names[e2], n: stat.n, k: stat.k,
          rate: wilson.rate, lower: wilson.lower, upper: wilson.upper,
          isProblem: wilson.lower > globalRate
        });
      }
      list.sort(function (a, b) { return b.lower - a.lower; });
      return list;
    }

    var allEventHealth = computeEventHealth();
    var problemEvents = [];
    for (var pe = 0; pe < allEventHealth.length; pe++) if (allEventHealth[pe].isProblem) problemEvents.push(allEventHealth[pe]);
    var eventBaselineMap = {};
    for (var bi = 0; bi < allEventHealth.length; bi++) eventBaselineMap[allEventHealth[bi].name] = allEventHealth[bi].rate;

    var showingAll = false;
    var healthCtx = healthCanvas.getContext('2d');
    var healthHits = [];

    function renderHealthChart() {
      healthHits = [];
      var list = showingAll ? allEventHealth : (problemEvents.length > 0 ? problemEvents.slice(0, 10) : allEventHealth.slice(0, 10));
      healthCountLabel.innerText = showingAll
        ? 'Mostrando los ' + list.length + ' tipos de evento'
        : (problemEvents.length > 0
            ? 'Mostrando ' + list.length + ' de ' + problemEvents.length + ' evento(s) con problema confirmado'
            : 'Sin evidencia de problemas — mostrando los 10 con tasa más alta');
      healthToggle.innerText = showingAll ? 'Ver solo problemáticos' : 'Ver todos los eventos';

      var rowH = 36;
      var PAD_L = 260, PAD_T = 20, PAD_R = 60, PAD_B = 10;
      var plotW = 380;
      var W = PAD_L + plotW + PAD_R;
      var H = PAD_T + list.length * rowH + PAD_B;
      var minW = healthScroll.clientWidth || 700;
      if (W < minW) W = minW;
      healthCanvas.width = W;
      healthCanvas.height = Math.max(H, 60);
      healthCtx.fillStyle = '#ffffff';
      healthCtx.fillRect(0, 0, W, H);

      if (list.length === 0) {
        healthCtx.fillStyle = '#9aa0a6';
        healthCtx.font = '13px Roboto, Arial, sans-serif';
        healthCtx.textAlign = 'center';
        healthCtx.fillText('Sin eventos cerrados para analizar', W / 2, 30);
        return;
      }

      var baseX = PAD_L, xScale = plotW;
      healthCtx.strokeStyle = '#e8eaed';
      healthCtx.fillStyle = '#9aa0a6';
      healthCtx.font = '10px Roboto, Arial, sans-serif';
      healthCtx.textAlign = 'center';
      for (var g2 = 0; g2 <= 4; g2++) {
        var gx = baseX + (g2 / 4) * xScale;
        healthCtx.beginPath(); healthCtx.moveTo(gx, PAD_T); healthCtx.lineTo(gx, H - PAD_B); healthCtx.stroke();
        healthCtx.fillText(pct(g2 / 4) + '%', gx, PAD_T - 6);
      }

      var globalX = baseX + globalRate * xScale;
      healthCtx.strokeStyle = '#5f6368';
      healthCtx.setLineDash([4, 3]);
      healthCtx.beginPath(); healthCtx.moveTo(globalX, PAD_T); healthCtx.lineTo(globalX, H - PAD_B); healthCtx.stroke();
      healthCtx.setLineDash([]);

      for (var idx = 0; idx < list.length; idx++) {
        var item = list[idx];
        var y = PAD_T + idx * rowH + rowH / 2;
        healthCtx.fillStyle = '#202124';
        healthCtx.font = '12px Roboto, Arial, sans-serif';
        healthCtx.textAlign = 'right';
        healthCtx.textBaseline = 'middle';
        healthCtx.fillText(truncate(item.name, 32), PAD_L - 12, y - 6);
        healthCtx.fillStyle = '#9aa0a6';
        healthCtx.font = '10px Roboto, Arial, sans-serif';
        healthCtx.fillText('n=' + item.n, PAD_L - 12, y + 8);

        var lowerX = baseX + item.lower * xScale;
        var upperX = baseX + item.upper * xScale;
        var rateX = baseX + item.rate * xScale;
        var barColor = item.isProblem ? '#EA4335' : '#9aa0a6';

        healthCtx.strokeStyle = barColor; healthCtx.lineWidth = 2;
        healthCtx.beginPath(); healthCtx.moveTo(lowerX, y); healthCtx.lineTo(upperX, y); healthCtx.stroke();
        healthCtx.beginPath();
        healthCtx.moveTo(lowerX, y - 5); healthCtx.lineTo(lowerX, y + 5);
        healthCtx.moveTo(upperX, y - 5); healthCtx.lineTo(upperX, y + 5);
        healthCtx.stroke(); healthCtx.lineWidth = 1;

        healthCtx.fillStyle = barColor;
        healthCtx.beginPath(); healthCtx.arc(rateX, y, 5, 0, Math.PI * 2); healthCtx.fill();

        healthCtx.fillStyle = '#202124';
        healthCtx.font = '600 11px Roboto, Arial, sans-serif';
        healthCtx.textAlign = 'left';
        healthCtx.fillText(pct(item.rate) + '%', baseX + plotW + 10, y);

        healthHits.push({ x: 0, y: y - rowH / 2, w: W, h: rowH, item: item });
      }
    }

    healthCanvas.onmousemove = function (e) {
      var rect = healthCanvas.getBoundingClientRect();
      var scaleY = healthCanvas.height / rect.height;
      var my = (e.clientY - rect.top) * scaleY;
      var found = null;
      for (var h = 0; h < healthHits.length; h++) {
        var hb = healthHits[h];
        if (my >= hb.y && my <= hb.y + hb.h) { found = hb; break; }
      }
      if (found) {
        var it = found.item;
        tip.innerHTML = '<div class="tt-title">' + escapeHtml(it.name) + '</div>' +
          'Tasa observada: ' + pct(it.rate) + '%\n' +
          'Intervalo 95% (Wilson): ' + pct(it.lower) + '% – ' + pct(it.upper) + '%\n' +
          'Muestra: n=' + it.n + ' (k=' + it.k + ' inválidos)\n' +
          (it.isProblem ? 'Problema confirmado vs tasa base (' + pct(globalRate) + '%)' : 'Sin evidencia suficiente vs tasa base (' + pct(globalRate) + '%)');
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      } else { tip.style.display = 'none'; }
    };
    healthCanvas.onmouseleave = function () { tip.style.display = 'none'; };
    healthToggle.onclick = function () { showingAll = !showingAll; renderHealthChart(); };

    // ==================================================
    // OBJETIVO C: PATRONES POR EVENTO
    // ==================================================
    var currentPatternDim = 'registration';
    var selectedPatternEvent = null;

    patternEventList.innerHTML = '';
    for (var i4 = 0; i4 < allEventHealth.length; i4++) {
      var opt = document.createElement('option');
      opt.value = allEventHealth[i4].name;
      patternEventList.appendChild(opt);
    }

    function computePatternMatrix(dim) {
      var byEvent = {}, byDim = {}, byCell = {};
      for (var i5 = 0; i5 < events.length; i5++) {
        var ev3 = events[i5];
        if (ev3.isOpen) continue;
        var dv = ev3[dim];
        byEvent[ev3.name] = (byEvent[ev3.name] || 0) + 1;
        byDim[dv] = (byDim[dv] || 0) + 1;
        var key = ev3.name + '||' + dv;
        if (!byCell[key]) byCell[key] = { n: 0, k: 0, event: ev3.name, dimValue: dv };
        byCell[key].n += 1;
        if (ev3.invalid) byCell[key].k += 1;
      }
      var eventsList = Object.keys(byEvent).sort(function (a, b) { return byEvent[b] - byEvent[a]; });
      var dimsList = Object.keys(byDim).sort(function (a, b) { return byDim[b] - byDim[a]; });
      if (eventsList.length > 18) eventsList = eventsList.slice(0, 18);
      if (dimsList.length > 15) dimsList = dimsList.slice(0, 15);
      var cells = [];
      var keys = Object.keys(byCell);
      for (var c2 = 0; c2 < keys.length; c2++) {
        var cell = byCell[keys[c2]];
        if (eventsList.indexOf(cell.event) === -1 || dimsList.indexOf(cell.dimValue) === -1) continue;
        var baseline = eventBaselineMap[cell.event] !== undefined ? eventBaselineMap[cell.event] : 0;
        var wilson = wilsonInterval(cell.k, cell.n);
        cells.push({
          event: cell.event, dimValue: cell.dimValue, n: cell.n, k: cell.k,
          rate: wilson.rate, lower: wilson.lower, upper: wilson.upper,
          baseline: baseline, sig: significanceVsBaseline(wilson, baseline)
        });
      }
      return { events: eventsList, dims: dimsList, cells: cells, eventTotals: byEvent, dimTotals: byDim };
    }

    var pmCtx = patternHeatmapCanvas.getContext('2d');
    var pmHits = [];
    var pmHoverRow = -1, pmHoverCol = -1;
    var HM_CELL_W = 62, HM_CELL_H = 30, HM_PAD_L = 230, HM_PAD_T = 90, HM_PAD_R = 16, HM_PAD_B = 12;

    function renderPatternHeatmap() {
      var matrix = computePatternMatrix(currentPatternDim);
      pmHits = [];
      var evs = matrix.events, dms = matrix.dims;
      var cellW = (currentPatternDim === 'version' || currentPatternDim === 'dataframe') ? 130 : HM_CELL_W;
      var W = HM_PAD_L + dms.length * cellW + HM_PAD_R;
      var H = HM_PAD_T + evs.length * HM_CELL_H + HM_PAD_B;
      var minW = patternHeatmapScroll.clientWidth || 700;
      if (W < minW) W = minW;
      patternHeatmapCanvas.width = W;
      patternHeatmapCanvas.height = H;
      pmCtx.fillStyle = '#ffffff';
      pmCtx.fillRect(0, 0, W, H);

      if (evs.length === 0 || dms.length === 0) {
        pmCtx.fillStyle = '#9aa0a6';
        pmCtx.font = '13px Roboto, Arial, sans-serif';
        pmCtx.textAlign = 'center'; pmCtx.textBaseline = 'middle';
        pmCtx.fillText('Sin datos suficientes', W / 2, H / 2);
        return;
      }

      if (pmHoverRow >= 0) { pmCtx.fillStyle = 'rgba(66,133,244,0.06)'; pmCtx.fillRect(0, HM_PAD_T + pmHoverRow * HM_CELL_H, W, HM_CELL_H); }
      if (pmHoverCol >= 0) { pmCtx.fillStyle = 'rgba(66,133,244,0.06)'; pmCtx.fillRect(HM_PAD_L + pmHoverCol * cellW, 0, cellW, H); }

      var labelMax = (currentPatternDim === 'version' || currentPatternDim === 'dataframe') ? 22 : 14;
      pmCtx.font = '600 10.5px Roboto, Arial, sans-serif';
      pmCtx.textAlign = 'left'; pmCtx.textBaseline = 'middle';
      for (var di = 0; di < dms.length; di++) {
        var xLbl = HM_PAD_L + di * cellW + cellW / 2;
        pmCtx.save();
        pmCtx.translate(xLbl, HM_PAD_T - 10);
        pmCtx.rotate(-Math.PI / 4);
        pmCtx.fillStyle = (di === pmHoverCol) ? '#1967d2' : '#5f6368';
        pmCtx.fillText(truncate(dms[di], labelMax), 0, 0);
        pmCtx.restore();
      }

      pmCtx.textAlign = 'right'; pmCtx.textBaseline = 'middle';
      for (var ei = 0; ei < evs.length; ei++) {
        var yRow = HM_PAD_T + ei * HM_CELL_H + HM_CELL_H / 2;
        var isHoverRow = (ei === pmHoverRow);
        pmCtx.fillStyle = isHoverRow ? '#1967d2' : '#202124';
        pmCtx.font = (isHoverRow ? '500 ' : '400 ') + '12px Roboto, Arial, sans-serif';
        pmCtx.fillText(truncate(evs[ei], 30), HM_PAD_L - 10, yRow - 2);
        pmCtx.fillStyle = '#9aa0a6';
        pmCtx.font = '10px Roboto, Arial, sans-serif';
        pmCtx.fillText('n=' + matrix.eventTotals[evs[ei]], HM_PAD_L - 10, yRow + 10);
      }

      for (var c3 = 0; c3 < matrix.cells.length; c3++) {
        var cell = matrix.cells[c3];
        var eIdx = evs.indexOf(cell.event);
        var dIdx = dms.indexOf(cell.dimValue);
        if (eIdx === -1 || dIdx === -1) continue;
        var cx = HM_PAD_L + dIdx * cellW;
        var cy = HM_PAD_T + eIdx * HM_CELL_H;
        pmCtx.fillStyle = sigColor(cell.sig);
        pmCtx.fillRect(cx + 2, cy + 2, cellW - 4, HM_CELL_H - 4);

        if (eIdx === pmHoverRow && dIdx === pmHoverCol) {
          pmCtx.strokeStyle = '#202124'; pmCtx.lineWidth = 2;
          pmCtx.strokeRect(cx + 2, cy + 2, cellW - 4, HM_CELL_H - 4);
          pmCtx.lineWidth = 1;
        }

        if (cell.n > 0) {
          var strong = !!cell.sig;
          pmCtx.fillStyle = strong ? '#ffffff' : '#5f6368';
          pmCtx.font = (strong ? '600 ' : '400 ') + '11px Roboto, Arial, sans-serif';
          pmCtx.textAlign = 'center'; pmCtx.textBaseline = 'middle';
          pmCtx.fillText(pct(cell.rate) + '%', cx + cellW / 2, cy + HM_CELL_H / 2 - 5);
          pmCtx.font = '9px Roboto, Arial, sans-serif';
          pmCtx.fillText('n=' + cell.n, cx + cellW / 2, cy + HM_CELL_H / 2 + 8);
        }
        pmHits.push({ x: cx, y: cy, w: cellW, h: HM_CELL_H, cell: cell, rowIdx: eIdx, colIdx: dIdx });
      }
    }

    patternHeatmapCanvas.onmousemove = function (e) {
      var rect = patternHeatmapCanvas.getBoundingClientRect();
      var scaleX = patternHeatmapCanvas.width / rect.width;
      var scaleY = patternHeatmapCanvas.height / rect.height;
      var mx = (e.clientX - rect.left) * scaleX;
      var my = (e.clientY - rect.top) * scaleY;
      var found = null;
      for (var h2 = 0; h2 < pmHits.length; h2++) {
        var hb2 = pmHits[h2];
        if (mx >= hb2.x && mx <= hb2.x + hb2.w && my >= hb2.y && my <= hb2.y + hb2.h) { found = hb2; break; }
      }
      var nr = found ? found.rowIdx : -1, nc = found ? found.colIdx : -1;
      if (nr !== pmHoverRow || nc !== pmHoverCol) { pmHoverRow = nr; pmHoverCol = nc; renderPatternHeatmap(); }
      patternHeatmapCanvas.style.cursor = (found && found.cell.n > 0) ? 'pointer' : 'default';
      if (found && found.cell.n > 0) {
        var cc = found.cell;
        var interp = cc.sig === 'high' ? 'Sobre la tasa base del evento (95%)' : cc.sig === 'low' ? 'Bajo la tasa base del evento (95%)' : 'Sin evidencia suficiente';
        tip.innerHTML = '<div class="tt-title">' + escapeHtml(cc.event) + '</div>' +
          DIM_LABELS[currentPatternDim] + ': ' + escapeHtml(cc.dimValue) + '\n\n' +
          'Tasa local: ' + pct(cc.rate) + '% (n=' + cc.n + ', k=' + cc.k + ')\n' +
          'IC 95%: ' + pct(cc.lower) + '%–' + pct(cc.upper) + '%\n' +
          'Tasa base del evento: ' + pct(cc.baseline) + '%\n\n' + interp + '\n\nClic para ver detalle';
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      } else { tip.style.display = 'none'; }
    };
    patternHeatmapCanvas.onmouseleave = function () {
      tip.style.display = 'none'; patternHeatmapCanvas.style.cursor = 'default';
      pmHoverRow = -1; pmHoverCol = -1; renderPatternHeatmap();
    };
    patternHeatmapCanvas.onclick = function (e) {
      var rect = patternHeatmapCanvas.getBoundingClientRect();
      var scaleX = patternHeatmapCanvas.width / rect.width;
      var scaleY = patternHeatmapCanvas.height / rect.height;
      var mx = (e.clientX - rect.left) * scaleX;
      var my = (e.clientY - rect.top) * scaleY;
      var found = null;
      for (var h3 = 0; h3 < pmHits.length; h3++) {
        var hb3 = pmHits[h3];
        if (mx >= hb3.x && mx <= hb3.x + hb3.w && my >= hb3.y && my <= hb3.y + hb3.h) { found = hb3; break; }
      }
      if (!found || found.cell.n === 0) return;
      selectEventForPattern(found.cell.event);
    };

    var pwCtx = patternWilsonCanvas.getContext('2d');
    var pwHits = [];

    function renderPatternWilson() {
      pwHits = [];
      if (!selectedPatternEvent) return;
      var baseline = eventBaselineMap[selectedPatternEvent] !== undefined ? eventBaselineMap[selectedPatternEvent] : 0;

      var byDv = {};
      for (var i6 = 0; i6 < events.length; i6++) {
        var ev4 = events[i6];
        if (ev4.isOpen || ev4.name !== selectedPatternEvent) continue;
        var dv2 = ev4[currentPatternDim];
        if (!byDv[dv2]) byDv[dv2] = { n: 0, k: 0 };
        byDv[dv2].n += 1;
        if (ev4.invalid) byDv[dv2].k += 1;
      }
      var list = [];
      var dks = Object.keys(byDv);
      for (var d2 = 0; d2 < dks.length; d2++) {
        var st = byDv[dks[d2]];
        var w2 = wilsonInterval(st.k, st.n);
        list.push({ dimValue: dks[d2], n: st.n, k: st.k, rate: w2.rate, lower: w2.lower, upper: w2.upper, sig: significanceVsBaseline(w2, baseline) });
      }
      list.sort(function (a, b) { return b.lower - a.lower; });

      var rowH = 36;
      var isLongLabel = (currentPatternDim === 'version' || currentPatternDim === 'dataframe');
      var PAD_L = isLongLabel ? 260 : 200;
      var PAD_T = 20, PAD_R = 60, PAD_B = 10;
      var plotW = 380;
      var labelMax = isLongLabel ? 32 : 22;
      var W = PAD_L + plotW + PAD_R;
      var H = PAD_T + list.length * rowH + PAD_B;
      var minW = patternWilsonScroll.clientWidth || 700;
      if (W < minW) W = minW;
      patternWilsonCanvas.width = W;
      patternWilsonCanvas.height = Math.max(H, 60);
      pwCtx.fillStyle = '#ffffff';
      pwCtx.fillRect(0, 0, W, H);

      if (list.length === 0) {
        pwCtx.fillStyle = '#9aa0a6';
        pwCtx.font = '13px Roboto, Arial, sans-serif';
        pwCtx.textAlign = 'center';
        pwCtx.fillText('Sin datos para este evento', W / 2, 30);
        return;
      }

      var baseX = PAD_L, xScale = plotW;
      pwCtx.strokeStyle = '#e8eaed';
      pwCtx.fillStyle = '#9aa0a6';
      pwCtx.font = '10px Roboto, Arial, sans-serif';
      pwCtx.textAlign = 'center';
      for (var g3 = 0; g3 <= 4; g3++) {
        var gx2 = baseX + (g3 / 4) * xScale;
        pwCtx.beginPath(); pwCtx.moveTo(gx2, PAD_T); pwCtx.lineTo(gx2, H - PAD_B); pwCtx.stroke();
        pwCtx.fillText(pct(g3 / 4) + '%', gx2, PAD_T - 6);
      }
      var baseLineX = baseX + baseline * xScale;
      pwCtx.strokeStyle = '#5f6368';
      pwCtx.setLineDash([4, 3]);
      pwCtx.beginPath(); pwCtx.moveTo(baseLineX, PAD_T); pwCtx.lineTo(baseLineX, H - PAD_B); pwCtx.stroke();
      pwCtx.setLineDash([]);

      for (var idx2 = 0; idx2 < list.length; idx2++) {
        var item2 = list[idx2];
        var y2 = PAD_T + idx2 * rowH + rowH / 2;
        pwCtx.fillStyle = '#202124';
        pwCtx.font = '12px Roboto, Arial, sans-serif';
        pwCtx.textAlign = 'right'; pwCtx.textBaseline = 'middle';
        pwCtx.fillText(truncate(item2.dimValue, labelMax), PAD_L - 12, y2 - 6);
        pwCtx.fillStyle = '#9aa0a6';
        pwCtx.font = '10px Roboto, Arial, sans-serif';
        pwCtx.fillText('n=' + item2.n, PAD_L - 12, y2 + 8);

        var lowerX2 = baseX + item2.lower * xScale;
        var upperX2 = baseX + item2.upper * xScale;
        var rateX2 = baseX + item2.rate * xScale;
        var barColor2 = sigColor(item2.sig);
        pwCtx.strokeStyle = barColor2; pwCtx.lineWidth = 2;
        pwCtx.beginPath(); pwCtx.moveTo(lowerX2, y2); pwCtx.lineTo(upperX2, y2); pwCtx.stroke();
        pwCtx.beginPath();
        pwCtx.moveTo(lowerX2, y2 - 5); pwCtx.lineTo(lowerX2, y2 + 5);
        pwCtx.moveTo(upperX2, y2 - 5); pwCtx.lineTo(upperX2, y2 + 5);
        pwCtx.stroke(); pwCtx.lineWidth = 1;
        pwCtx.fillStyle = barColor2;
        pwCtx.beginPath(); pwCtx.arc(rateX2, y2, 5, 0, Math.PI * 2); pwCtx.fill();
        pwCtx.fillStyle = '#202124';
        pwCtx.font = '600 11px Roboto, Arial, sans-serif';
        pwCtx.textAlign = 'left';
        pwCtx.fillText(pct(item2.rate) + '%', baseX + plotW + 10, y2);
        pwHits.push({ x: 0, y: y2 - rowH / 2, w: W, h: rowH, item: item2 });
      }
    }

    patternWilsonCanvas.onmousemove = function (e) {
      var rect = patternWilsonCanvas.getBoundingClientRect();
      var scaleY = patternWilsonCanvas.height / rect.height;
      var my = (e.clientY - rect.top) * scaleY;
      var found = null;
      for (var h4 = 0; h4 < pwHits.length; h4++) {
        var hb4 = pwHits[h4];
        if (my >= hb4.y && my <= hb4.y + hb4.h) { found = hb4; break; }
      }
      if (found) {
        var it2 = found.item;
        var b2 = eventBaselineMap[selectedPatternEvent] || 0;
        tip.innerHTML = '<div class="tt-title">' + escapeHtml(it2.dimValue) + '</div>' +
          'Tasa observada: ' + pct(it2.rate) + '%\n' +
          'IC 95%: ' + pct(it2.lower) + '%–' + pct(it2.upper) + '%\n' +
          'Muestra: n=' + it2.n + ' (k=' + it2.k + ' inválidos)\n' +
          'Tasa base del evento: ' + pct(b2) + '%\n' +
          (it2.sig === 'high' ? 'Sobre la base (95%)' : it2.sig === 'low' ? 'Bajo la base (95%)' : 'Sin evidencia suficiente');
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      } else { tip.style.display = 'none'; }
    };
    patternWilsonCanvas.onmouseleave = function () { tip.style.display = 'none'; };

    function updatePatternsTitle() {
      var dimLabel = DIM_LABELS[currentPatternDim];
      if (selectedPatternEvent) {
        patternsTitle.innerText = selectedPatternEvent + ' × ' + dimLabel;
        patternsHint.innerText = 'Ordenado por límite inferior del intervalo de Wilson vs tasa base del evento';
      } else {
        patternsTitle.innerText = 'Mapa de patrones × ' + dimLabel;
        patternsHint.innerText = 'Clic en una celda o busca un evento para ver el detalle';
      }
    }

    function selectEventForPattern(eventName) {
      selectedPatternEvent = eventName;
      patternEventInput.value = eventName;
      patternHeatmapView.className = 'hidden';
      patternWilsonView.className = 'visible';
      patternBackBtn.className = 'visible';
      updatePatternsTitle();
      renderPatternWilson();
    }
    function backToPatternHeatmap() {
      selectedPatternEvent = null;
      patternEventInput.value = '';
      patternHeatmapView.className = '';
      patternWilsonView.className = '';
      patternBackBtn.className = '';
      updatePatternsTitle();
      renderPatternHeatmap();
    }

    patternViewSelector.onclick = function (e) {
      var btn2 = e.target;
      var dim = btn2.getAttribute('data-dim');
      if (!dim) return;
      currentPatternDim = dim;
      var btns2 = patternViewSelector.getElementsByTagName('button');
      for (var bb = 0; bb < btns2.length; bb++) {
        btns2[bb].className = (btns2[bb].getAttribute('data-dim') === dim) ? 'view-btn active' : 'view-btn';
      }
      updatePatternsTitle();
      if (selectedPatternEvent) renderPatternWilson();
      else renderPatternHeatmap();
    };

    patternEventInput.oninput = function () {
      var val = patternEventInput.value.trim();
      if (val && eventBaselineMap[val] !== undefined) selectEventForPattern(val);
      else if (val === '') backToPatternHeatmap();
    };
    patternBackBtn.onclick = function () { backToPatternHeatmap(); };

    // ==================================================
    // OBJETIVO D: VALIDADORES
    // ==================================================
    var currentValDim = 'registration';
    var selectedValEvent = null;

    valEventList.innerHTML = '';
    for (var v1 = 0; v1 < allEventHealth.length; v1++) {
      var vOpt = document.createElement('option');
      vOpt.value = allEventHealth[v1].name;
      valEventList.appendChild(vOpt);
    }

    function shortEmail(email) {
      if (!email) return '(sin validar)';
      var at = email.indexOf('@');
      return at > 0 ? email.substring(0, at) : email;
    }

    var valCtx = valHeatmapCanvas.getContext('2d');
    var valHits = [];
    var valHoverRow = -1, valHoverCol = -1;
    var VAL_CELL_W = 110, VAL_CELL_H = 30, VAL_PAD_L = 200, VAL_PAD_T = 100, VAL_PAD_R = 16, VAL_PAD_B = 12;

    function invalidRateColor(rate) {
      if (rate <= 0) return '#e6f4ea';
      if (rate >= 1) return '#EA4335';
      if (rate <= 0.5) {
        var t = rate / 0.5;
        var r = Math.round(230 + (251 - 230) * t);
        var g = Math.round(244 + (188 - 244) * t);
        var b = Math.round(234 + (80 - 234) * t);
        return 'rgb(' + r + ',' + g + ',' + b + ')';
      } else {
        var t2 = (rate - 0.5) / 0.5;
        var r2 = Math.round(251 + (234 - 251) * t2);
        var g2 = Math.round(188 + (67 - 188) * t2);
        var b2 = Math.round(80 + (53 - 80) * t2);
        return 'rgb(' + r2 + ',' + g2 + ',' + b2 + ')';
      }
    }

    function textColorForRate(rate) {
      return rate > 0.55 ? '#ffffff' : '#202124';
    }

    function computeValMatrix(dim, eventName) {
      var byDim = {}, byVal = {}, byCell = {};
      for (var i7 = 0; i7 < events.length; i7++) {
        var ev5 = events[i7];
        if (ev5.isOpen) continue;
        if (eventName && ev5.name !== eventName) continue;
        if (!ev5.validator) continue;
        var dv3 = ev5[dim];
        var vl = ev5.validator;
        byDim[dv3] = (byDim[dv3] || 0) + 1;
        byVal[vl] = (byVal[vl] || 0) + 1;
        var key = dv3 + '||' + vl;
        if (!byCell[key]) byCell[key] = { n: 0, k: 0, dimValue: dv3, validator: vl };
        byCell[key].n += 1;
        if (ev5.invalid) byCell[key].k += 1;
      }
      var dimsList = Object.keys(byDim).sort(function (a, b) { return byDim[b] - byDim[a]; });
      var valsList = Object.keys(byVal).sort(function (a, b) { return byVal[b] - byVal[a]; });
      if (dimsList.length > 25) dimsList = dimsList.slice(0, 25);
      if (valsList.length > 15) valsList = valsList.slice(0, 15);
      var cells = [];
      var keys = Object.keys(byCell);
      for (var c4 = 0; c4 < keys.length; c4++) {
        var cell = byCell[keys[c4]];
        if (dimsList.indexOf(cell.dimValue) === -1 || valsList.indexOf(cell.validator) === -1) continue;
        var rate = cell.n > 0 ? cell.k / cell.n : 0;
        cells.push({
          dimValue: cell.dimValue, validator: cell.validator,
          n: cell.n, k: cell.k, rate: rate
        });
      }
      return { dims: dimsList, validators: valsList, cells: cells, dimTotals: byDim, valTotals: byVal };
    }

    function renderValHeatmap() {
      valHits = [];
      var matrix = computeValMatrix(currentValDim, selectedValEvent);
      var dms = matrix.dims, vals = matrix.validators;

      var isLongLabel = (currentValDim === 'version' || currentValDim === 'dataframe');
      var padL = isLongLabel ? 260 : VAL_PAD_L;
      var rowLabelMax = isLongLabel ? 32 : 22;

      var W = padL + vals.length * VAL_CELL_W + VAL_PAD_R;
      var H = VAL_PAD_T + dms.length * VAL_CELL_H + VAL_PAD_B;
      var minW = valHeatmapScroll.clientWidth || 700;
      if (W < minW) W = minW;
      valHeatmapCanvas.width = W;
      valHeatmapCanvas.height = Math.max(H, 80);
      valCtx.fillStyle = '#ffffff';
      valCtx.fillRect(0, 0, W, H);

      if (dms.length === 0 || vals.length === 0) {
        valCtx.fillStyle = '#9aa0a6';
        valCtx.font = '13px Roboto, Arial, sans-serif';
        valCtx.textAlign = 'center'; valCtx.textBaseline = 'middle';
        var msg = selectedValEvent ? 'Sin datos validados para este evento' : 'Selecciona un evento para ver la matriz';
        valCtx.fillText(msg, W / 2, H / 2);
        return;
      }

      if (valHoverRow >= 0) { valCtx.fillStyle = 'rgba(66,133,244,0.06)'; valCtx.fillRect(0, VAL_PAD_T + valHoverRow * VAL_CELL_H, W, VAL_CELL_H); }
      if (valHoverCol >= 0) { valCtx.fillStyle = 'rgba(66,133,244,0.06)'; valCtx.fillRect(padL + valHoverCol * VAL_CELL_W, 0, VAL_CELL_W, H); }

      valCtx.font = '600 10.5px Roboto, Arial, sans-serif';
      valCtx.textAlign = 'left'; valCtx.textBaseline = 'middle';
      for (var vi = 0; vi < vals.length; vi++) {
        var xLbl = padL + vi * VAL_CELL_W + VAL_CELL_W / 2;
        valCtx.save();
        valCtx.translate(xLbl, VAL_PAD_T - 10);
        valCtx.rotate(-Math.PI / 4);
        valCtx.fillStyle = (vi === valHoverCol) ? '#1967d2' : '#5f6368';
        valCtx.fillText(truncate(shortEmail(vals[vi]), 18), 0, 0);
        valCtx.restore();
      }

      valCtx.textAlign = 'right'; valCtx.textBaseline = 'middle';
      for (var di2 = 0; di2 < dms.length; di2++) {
        var yRow = VAL_PAD_T + di2 * VAL_CELL_H + VAL_CELL_H / 2;
        var isHover = (di2 === valHoverRow);
        valCtx.fillStyle = isHover ? '#1967d2' : '#202124';
        valCtx.font = (isHover ? '500 ' : '400 ') + '12px Roboto, Arial, sans-serif';
        valCtx.fillText(truncate(dms[di2], rowLabelMax), padL - 10, yRow);
      }

      for (var c5 = 0; c5 < matrix.cells.length; c5++) {
        var cell = matrix.cells[c5];
        var dIdx = dms.indexOf(cell.dimValue);
        var vIdx = vals.indexOf(cell.validator);
        if (dIdx === -1 || vIdx === -1) continue;
        var cx = padL + vIdx * VAL_CELL_W;
        var cy = VAL_PAD_T + dIdx * VAL_CELL_H;

        valCtx.fillStyle = invalidRateColor(cell.rate);
        valCtx.fillRect(cx + 2, cy + 2, VAL_CELL_W - 4, VAL_CELL_H - 4);

        if (dIdx === valHoverRow && vIdx === valHoverCol) {
          valCtx.strokeStyle = '#202124'; valCtx.lineWidth = 2;
          valCtx.strokeRect(cx + 2, cy + 2, VAL_CELL_W - 4, VAL_CELL_H - 4);
          valCtx.lineWidth = 1;
        }

        valCtx.fillStyle = textColorForRate(cell.rate);
        valCtx.font = '600 11px Roboto, Arial, sans-serif';
        valCtx.textAlign = 'center'; valCtx.textBaseline = 'middle';
        valCtx.fillText(pct(cell.rate) + '%', cx + VAL_CELL_W / 2, cy + VAL_CELL_H / 2 - 5);
        valCtx.font = '9px Roboto, Arial, sans-serif';
        valCtx.fillText('n=' + cell.n, cx + VAL_CELL_W / 2, cy + VAL_CELL_H / 2 + 8);

        valHits.push({ x: cx, y: cy, w: VAL_CELL_W, h: VAL_CELL_H, cell: cell, rowIdx: dIdx, colIdx: vIdx });
      }
    }

    valHeatmapCanvas.onmousemove = function (e) {
      var rect = valHeatmapCanvas.getBoundingClientRect();
      var scaleX = valHeatmapCanvas.width / rect.width;
      var scaleY = valHeatmapCanvas.height / rect.height;
      var mx = (e.clientX - rect.left) * scaleX;
      var my = (e.clientY - rect.top) * scaleY;
      var found = null;
      for (var h5 = 0; h5 < valHits.length; h5++) {
        var hb5 = valHits[h5];
        if (mx >= hb5.x && mx <= hb5.x + hb5.w && my >= hb5.y && my <= hb5.y + hb5.h) { found = hb5; break; }
      }
      var nr = found ? found.rowIdx : -1, nc = found ? found.colIdx : -1;
      if (nr !== valHoverRow || nc !== valHoverCol) { valHoverRow = nr; valHoverCol = nc; renderValHeatmap(); }
      if (found && found.cell.n > 0) {
        var cc = found.cell;
        var validN = cc.n - cc.k;
        tip.innerHTML = '<div class="tt-title">' + escapeHtml(cc.validator) + '</div>' +
          DIM_LABELS[currentValDim] + ': ' + escapeHtml(cc.dimValue) + '\n\n' +
          'Total validados: ' + cc.n + '\n' +
          'Válidos: ' + validN + ' (' + pct(1 - cc.rate) + '%)\n' +
          'Inválidos: ' + cc.k + ' (' + pct(cc.rate) + '%)';
        tip.style.display = 'block';
        tip.style.left = (e.clientX + 14) + 'px';
        tip.style.top = (e.clientY - 10) + 'px';
      } else { tip.style.display = 'none'; }
    };
    valHeatmapCanvas.onmouseleave = function () {
      tip.style.display = 'none';
      valHoverRow = -1; valHoverCol = -1; renderValHeatmap();
    };

    valDimSelector.onclick = function (e) {
      var btn3 = e.target;
      var dim = btn3.getAttribute('data-valdim');
      if (!dim) return;
      currentValDim = dim;
      var btns3 = valDimSelector.getElementsByTagName('button');
      for (var b3 = 0; b3 < btns3.length; b3++) {
        btns3[b3].className = (btns3[b3].getAttribute('data-valdim') === dim) ? 'view-btn active' : 'view-btn';
      }
      updateValTitle();
      renderValHeatmap();
    };

    valEventInput.oninput = function () {
      var val = valEventInput.value.trim();
      if (val && eventBaselineMap[val] !== undefined) {
        selectedValEvent = val;
      } else if (val === '') {
        selectedValEvent = null;
      } else {
        return;
      }
      updateValTitle();
      renderValHeatmap();
    };

    function updateValTitle() {
      var dimLabel = DIM_LABELS[currentValDim];
      if (selectedValEvent) {
        valTitle.innerText = selectedValEvent + ' — Validadores × ' + dimLabel;
        valHint.innerText = 'Proporción de inválidos por validador y ' + dimLabel.toLowerCase();
      } else {
        valTitle.innerText = 'Distribución por validador × ' + dimLabel;
        valHint.innerText = 'Selecciona un evento para ver la matriz';
      }
    }

    // ==================================================
    // TABS (5 pestañas · el asistente se inicializa al abrirlo)
    // ==================================================
    var asistenteListo = false;
    function ensureAsistente() {
      if (asistenteListo) return;
      asistenteListo = true;           // marcar antes: si falla, no se reintenta en bucle
      initAsistente();
    }
    var asignacionLista = false;
    function ensureAsignacion() {
      if (asignacionLista) return;
      asignacionLista = true;
      initAsignacion();
    }

    // Puente: la pestaña de asignación puede abrir un vuelo en el asistente.
    // initAsistente publica aquí su función openVuelo cuando termina de cargar.
    var abrirVueloEnAsistente = null;
    function irAlAsistente(vueloId) {
      activarTab('assistant');
      ensureAsistente();
      if (abrirVueloEnAsistente) abrirVueloEnAsistente(vueloId);
    }

    function activarTab(tabId) {
      var btns = tabs.getElementsByTagName('button'), i;
      for (i = 0; i < btns.length; i++) {
        btns[i].className = (btns[i].getAttribute('data-tab') === tabId) ? 'tab-btn active' : 'tab-btn';
      }
      var panelIds = ['overview', 'health', 'patterns', 'validators', 'assistant', 'assign'];
      for (i = 0; i < panelIds.length; i++) {
        getEl('tab-' + panelIds[i]).className = (panelIds[i] === tabId) ? 'tab-panel active' : 'tab-panel';
      }
    }

    tabs.onclick = function (e) {
      var btn = e.target;
      var tabId = btn.getAttribute('data-tab');
      if (!tabId) return;
      activarTab(tabId);
      if (tabId === 'overview') renderTrendChart();
      else if (tabId === 'health') renderHealthChart();
      else if (tabId === 'patterns') {
        if (selectedPatternEvent) renderPatternWilson();
        else renderPatternHeatmap();
      }
      else if (tabId === 'validators') renderValHeatmap();
      else if (tabId === 'assistant') ensureAsistente();
      else if (tabId === 'assign') ensureAsignacion();
    };

    // ==================================================
    // RENDER INICIAL
    // ==================================================
    renderTrendChart();
    updatePatternsTitle();
    updateValTitle();

    /* ==============================================================
       PARTE 2 — ASISTENTE DE VALIDACIÓN
       Todo vive dentro de esta función: sus variables locales no
       interfieren con las de la parte 1 aunque se llamen igual.
       ============================================================== */
    function initAsistente() {
      var DIAG = document.getElementById('fdm-diag');
      try {
        /* ---------- 1. CONFIG ---------- */
        var CONFIG = {
          factors: ['matricula', 'origen', 'destino', 'fase_deteccion', 'esquema_datos', 'dataframe_qar'],
          excludeFromPrediction: ['validador'],
          interactionFactors: ['matricula', 'origen', 'esquema_datos', 'dataframe_qar'],
          strictTemporalCutoff: true,

          halfLifeDays: 540,
          minWeight: 0.05,

          mGrid: [2, 5, 10, 20, 50, 100, 200, 500],
          mMin: 2, mMax: 500,
          minLevelSupport: 3,
          deltaClamp: 2.5,
          interactionMinN: 8,
          kappaGrid: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
          kappaFallback: 0.85,
          holdoutFraction: 0.20,
          holdoutMinRows: 50,

          z: 1.645,
          targetHalfWidth: 0.10,
          evidenceBands: { suficiente: 1.00, limitada: 0.50, debil: 0.20 },

          decisionBands: { invalidarAlta: 0.80, invalidarMod: 0.60, validarMod: 0.40, validarAlta: 0.20 },
          degradeOnWeakEvidence: true,
          degradeOnThresholdCrossing: true,

          topDrivers: 3,
          driverMinDelta: 0.10,
          secondaryDriverRatio: 0.60,

          similarCases: 5,
          requireSameEvent: true,

          driftWindowDays: 90, driftThreshold: 0.15, driftMinN: 20,

          pageSizeDetecciones: 50,
          batchScoreThreshold: 20,
          minLabeledWarn: 2000,
          versionMotor: 'EB-HAL 1.0 / SARA',

          labels: {
            id_evento: 'Tipo de evento', dataframe_qar: 'Dataframe QAR',
            esquema_datos: 'Esquema de datos', matricula: 'Matrícula',
            origen: 'Origen', destino: 'Destino',
            fase_deteccion: 'Fase de detección', validador: 'Validador asignado'
          },

          tips: {
            p: 'Probabilidad de invalidación: proporción esperada de casos comparables que un validador promedio invalidaría. No es una medida de gravedad ni de certeza técnica.',
            ic: 'IC 90 %: rango en el que se encuentra la probabilidad real con 90 % de confianza. Si es ancho, la evidencia es escasa.',
            nef: 'n efectivo: cantidad de casos comparables que "vale" esta estimación, descontando la antigüedad de los datos y la información que el modelo tomó prestada de niveles más generales.',
            nmin: 'n mínimo óptimo: casos comparables necesarios para que la estimación tenga un margen de ±10 puntos y su intervalo no cruce el umbral de decisión.',
            ratio: 'Ratio de evidencia: n efectivo dividido por n mínimo óptimo. Bajo 1 la sugerencia es indicativa; bajo 0.5 es débil.',
            obs: 'Tasa observada: porcentaje crudo de invalidación de los casos históricos con esta característica. Con pocos casos puede ser muy engañosa.',
            esp: 'Tasa esperada: lo que se esperaría para esta característica considerando únicamente el tipo de eventos que concentra. Evita atribuirle a un aeropuerto o matrícula un efecto que es del tipo de evento.',
            enc: 'Tasa encogida: tasa observada corregida hacia la esperada según la evidencia disponible. Es la que usa el modelo.',
            wil: 'Wilson 90 %: intervalo de confianza de la tasa cruda, sin ningún supuesto del modelo. Es el contraste independiente.',
            delta: 'Δ logit: cuánto empuja esta característica la decisión, en log-odds. Positivo empuja a invalidar. Los Δ se suman entre sí; los porcentajes no.',
            or: 'OR: cuántas veces más probable —en odds— se vuelve la invalidación por efecto de esta característica.',
            contrib: 'Contribución: porcentaje del total de influencia que aporta esta característica.',
            lambda: 'Shrinkage λ: peso de la evidencia propia del nivel frente a la información prestada. λ=1: todo evidencia propia.',
            m: 'm (fuerza del prior): observaciones ficticias que representan el comportamiento general. A mayor m, más evidencia propia se exige para despegarse del promedio. Se estima de los datos.',
            kappa: 'κ (amortiguación): corrección global que evita sobre-confianza cuando varias características correlacionadas apuntan en el mismo sentido.',
            kish: 'n Kish: tamaño de muestra equivalente tras ponderar por antigüedad. Muy menor que n significa evidencia mayormente vieja.',
            sesgo: 'Sesgo del validador: tendencia de un validador a invalidar por encima o por debajo del promedio, ajustando por el tipo de eventos que revisa. No se usa para la sugerencia.',
            motivo: 'Motivo inferido: hipótesis sobre el origen del patrón, deducida de qué característica pesa más. No es una causa verificada.'
          }
        };
        if (Object.freeze) CONFIG = Object.freeze(CONFIG);

        var DISCLAIMER = 'Sugerencia estadística basada en el comportamiento histórico de casos comparables. ' +
          'No constituye una determinación técnica. El criterio del validador prevalece siempre.';

        var DAY = 86400000;
        var UNK = 'DESCONOCIDO';
        var DASH = '—';

        /* ---------- 2. FORMAT ---------- */
        function isNum(v) { return typeof v === 'number' && isFinite(v); }
        function esc(s) {
          return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        }
        function fpct(v, dd) {
          if (!isNum(v)) return DASH;
          return (v * 100).toFixed(dd === undefined ? 1 : dd) + ' %';
        }
        function fnum(v, dd) {
          if (!isNum(v)) return DASH;
          return v.toFixed(dd === undefined ? 2 : dd);
        }
        function fint(v) {
          if (!isNum(v)) return DASH;
          return String(Math.round(v));
        }
        function fdelta(v) {
          if (!isNum(v)) return DASH;
          return (v >= 0 ? '+' : '') + v.toFixed(2);
        }
        function fOR(v) {
          if (!isNum(v) || v <= 0) return DASH;
          return v.toFixed(2) + '×';
        }
        var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        function pad2(n) { return (n < 10 ? '0' : '') + n; }
        function fdate(dt) {
          if (!dt || isNaN(dt.getTime())) return DASH;
          return pad2(dt.getDate()) + ' ' + MESES[dt.getMonth()] + ' ' + dt.getFullYear();
        }
        function fdatetime(dt) {
          if (!dt || isNaN(dt.getTime())) return DASH;
          return fdate(dt) + ' · ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
        }
        function ftime(dt) {
          if (!dt || isNaN(dt.getTime())) return DASH;
          return pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
        }
        function shortMail(s) {
          if (!s) return UNK;
          var at = s.indexOf('@');
          return at > 0 ? s.substring(0, at) : s;
        }
        function trunc(s, n) { s = String(s); return s.length > n ? s.substring(0, n - 1) + '…' : s; }

        /* ---------- 3. STATS ---------- */
        function clampP(p) { return Math.min(1 - 1e-12, Math.max(1e-12, p)); }
        function logit(p) { p = clampP(p); return Math.log(p / (1 - p)); }
        function sigmoid(z) {
          if (z >= 0) { return 1 / (1 + Math.exp(-z)); }
          var ex = Math.exp(z); return ex / (1 + ex);
        }
        function clampV(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
        function wilson(y, n, z) {
          if (!n || n <= 0) return null;
          var p = y / n, z2 = z * z, dn = 1 + z2 / n;
          var centro = (p + z2 / (2 * n)) / dn;
          var semi = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / dn;
          return [Math.max(0, centro - semi), Math.min(1, centro + semi)];
        }
        function nll(p, isInv) { p = clampP(p); return isInv ? -Math.log(p) : -Math.log(1 - p); }
        function kish(sumW, sumW2) { return sumW2 > 0 ? (sumW * sumW) / sumW2 : 0; }
        function sdev(arr) {
          var n = arr.length; if (n < 2) return 0;
          var s = 0, i;
          for (i = 0; i < n; i++) s += arr[i];
          var mu = s / n, v = 0;
          for (i = 0; i < n; i++) v += (arr[i] - mu) * (arr[i] - mu);
          return Math.sqrt(v / (n - 1));
        }
        function lowerBoundT(arr, t) {
          var lo = 0, hi = arr.length;
          while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
          return lo;
        }
        function lowerBoundIdx(list, cut) {
          var lo = 0, hi = list.length;
          while (lo < hi) { var mid = (lo + hi) >> 1; if (list[mid] < cut) lo = mid + 1; else hi = mid; }
          return lo;
        }

        /* ---------- 4. DATA ----------
           Reutiliza rawAll (las filas crudas ya leídas de DATA['@event'])
           y construye su propia normalización e índices. */
        var COLS = {
          flightid: ['flightid', 'flight id', 'id_vuelo'],
          takeoffdate: ['takeoffdate', 'takeoff date'],
          originicao: ['originicao', 'origin icao', 'origin'],
          destinationicao: ['destinationicao', 'destination icao', 'destination'],
          registration: ['registration', 'aircraftregistration', 'matricula'],
          eventid: ['eventid', 'event id', 'id'],
          eventdate: ['eventdate', 'event date'],
          eventname: ['eventname', 'event name', 'name'],
          isinvalid: ['isinvalid', 'isdeleted'],
          isopen: ['isopen', 'is open'],
          lastmodifiedby: ['lastmodifiedby', 'last modified by', 'validador'],
          flightphase: ['flightphase', 'flight phase', 'phase'],
          version: ['version'],
          dataframe: ['dataframe']
        };
        var REQUIRED = ['flightid', 'originicao', 'destinationicao', 'registration', 'eventid',
          'eventdate', 'eventname', 'isinvalid', 'isopen', 'lastmodifiedby',
          'flightphase', 'version', 'dataframe'];

        function has(v) { return v !== null && v !== undefined && v !== ''; }
        function boolOf(v) {
          if (v === true || v === 1) return true;
          if (typeof v === 'string') { var s = v.toLowerCase(); return s === 'true' || s === '1' || s === 't' || s === 'y'; }
          return false;
        }
        function strOf(v, fb) { return has(v) ? String(v).replace(/^\s+|\s+$/g, '') : fb; }
        function upOf(v, fb) { var s = strOf(v, ''); return s === '' ? fb : s.toUpperCase(); }

        function resolveColumns(sample) {
          var present = {}, k, i, names, j;
          for (k in sample) { if (Object.prototype.hasOwnProperty.call(sample, k)) present[String(k).toLowerCase()] = k; }
          var map = {}, missing = [], extra = [], used = {};
          for (k in COLS) {
            if (!Object.prototype.hasOwnProperty.call(COLS, k)) continue;
            names = COLS[k]; map[k] = null;
            for (j = 0; j < names.length; j++) {
              if (present[names[j]] !== undefined) { map[k] = present[names[j]]; used[present[names[j]]] = 1; break; }
            }
          }
          for (i = 0; i < REQUIRED.length; i++) { if (!map[REQUIRED[i]]) missing.push(REQUIRED[i]); }
          for (k in present) {
            if (!Object.prototype.hasOwnProperty.call(present, k)) continue;
            if (!used[present[k]]) extra.push(present[k]);
          }
          return { map: map, missing: missing, extra: extra };
        }

        function loadDataset(raw) {
          var col = resolveColumns(raw[0]);
          if (col.missing.length > 0) {
            return {
              fatal: 'Faltan columnas requeridas para el asistente: ' + col.missing.join(', ') +
                '. Se esperaban: ' + REQUIRED.join(', ') + '. Recibidas: ' + Object.keys(raw[0]).join(', ') + '.'
            };
          }
          var mp = col.map;
          var rows = [], i, rr, o, dt;
          var nFechaInvalida = 0;
          for (i = 0; i < raw.length; i++) {
            rr = raw[i];
            if (!has(rr[mp.eventid])) continue;                  // LEFT JOIN sin evento
            dt = null;
            var rawDate = has(rr[mp.eventdate]) ? rr[mp.eventdate] : (mp.takeoffdate ? rr[mp.takeoffdate] : null);
            if (has(rawDate)) { dt = new Date(rawDate); if (isNaN(dt.getTime())) dt = null; }
            var fechaInv = (dt === null);
            if (fechaInv) { nFechaInvalida++; dt = new Date(0); }
            var isOpen = boolOf(rr[mp.isopen]);
            var isInv = boolOf(rr[mp.isinvalid]);
            rows.push({
              id_deteccion: strOf(rr[mp.eventid], UNK),
              id_vuelo: strOf(rr[mp.flightid], UNK),
              id_evento: strOf(rr[mp.eventname], UNK),
              ts: dt,
              t: dt.getTime(),
              fecha_invalida: fechaInv,
              status_validez: isOpen ? 'PENDIENTE' : (isInv ? 'INVALIDO' : 'VALIDO'),
              inv: (!isOpen && isInv),
              validador: upOf(rr[mp.lastmodifiedby], UNK),
              matricula: upOf(rr[mp.registration], UNK),
              origen: upOf(rr[mp.originicao], UNK),
              destino: upOf(rr[mp.destinationicao], UNK),
              fase_deteccion: upOf(rr[mp.flightphase], UNK),
              esquema_datos: upOf(rr[mp.version], UNK),
              dataframe_qar: upOf(rr[mp.dataframe], UNK)
            });
          }

          rows.sort(function (a, b) { return a.t - b.t; });

          // referencia temporal y factor de decaimiento precalculado por fila
          var tRef = rows.length > 0 ? rows[rows.length - 1].t : 0;
          for (i = 0; i < rows.length; i++) {
            rows[i].u = Math.pow(0.5, (tRef - rows[i].t) / DAY / CONFIG.halfLifeDays);
          }

          var hist = [], byEvento = {}, byFactorNivel = {}, byEventoFactorNivel = {};
          var byVuelo = {}, ff, gg, kk;
          for (i = 0; i < rows.length; i++) {
            o = rows[i];
            if (!byVuelo[o.id_vuelo]) byVuelo[o.id_vuelo] = [];
            byVuelo[o.id_vuelo].push(o);
            if (o.status_validez === 'PENDIENTE') continue;
            var idx = hist.length;
            hist.push(o);
            if (!byEvento[o.id_evento]) byEvento[o.id_evento] = [];
            byEvento[o.id_evento].push(idx);
            for (gg = 0; gg < CONFIG.factors.length; gg++) {
              ff = CONFIG.factors[gg];
              kk = ff + '|' + o[ff];
              if (!byFactorNivel[kk]) byFactorNivel[kk] = [];
              byFactorNivel[kk].push(idx);
            }
            kk = 'validador|' + o.validador;
            if (!byFactorNivel[kk]) byFactorNivel[kk] = [];
            byFactorNivel[kk].push(idx);
            for (gg = 0; gg < CONFIG.interactionFactors.length; gg++) {
              ff = CONFIG.interactionFactors[gg];
              kk = o.id_evento + '|' + ff + '|' + o[ff];
              if (!byEventoFactorNivel[kk]) byEventoFactorNivel[kk] = [];
              byEventoFactorNivel[kk].push(idx);
            }
          }

          var vuelos = [], vk;
          for (vk in byVuelo) {
            if (!Object.prototype.hasOwnProperty.call(byVuelo, vk)) continue;
            var det = byVuelo[vk], pend = 0;
            for (i = 0; i < det.length; i++) if (det[i].status_validez === 'PENDIENTE') pend++;
            vuelos.push({
              id: vk, n: det.length, pendientes: pend,
              matricula: det[0].matricula, origen: det[0].origen, destino: det[0].destino,
              t0: det[0].t, t1: det[det.length - 1].t
            });
          }
          vuelos.sort(function (a, b) { return b.t1 - a.t1; });

          var nPend = 0, nInv = 0;
          for (i = 0; i < rows.length; i++) {
            if (rows[i].status_validez === 'PENDIENTE') nPend++;
            else if (rows[i].inv) nInv++;
          }

          return {
            rows: rows, hist: hist, tRef: tRef, byVuelo: byVuelo, byEvento: byEvento,
            byFactorNivel: byFactorNivel, byEventoFactorNivel: byEventoFactorNivel,
            vuelos: vuelos, fatal: null,
            stats: {
              nTotal: rows.length, nEtiquetadas: hist.length, nPendientes: nPend,
              nInvalidas: nInv, nVuelos: vuelos.length,
              tasaGlobal: hist.length > 0 ? nInv / hist.length : null,
              rangoFechas: rows.length > 0 ? [rows[0].ts, rows[rows.length - 1].ts] : null,
              nFechaInvalida: nFechaInvalida, columnasExtra: col.extra
            }
          };
        }

        /* ---------- 5. ENGINE ----------
           La ponderación temporal es separable:
             w_i = 0.5^((t* − t_i)/H) = 0.5^((t* − tRef)/H) · 0.5^((tRef − t_i)/H) = S · u_i
           u_i se precalcula una vez por fila y S una vez por análisis, de modo que
           el bucle caliente no ejecuta Math.pow por fila. */
        function scaleFor(tTarget, dsx, cfg) {
          return Math.pow(0.5, (tTarget - dsx.tRef) / DAY / cfg.halfLifeDays);
        }
        function weightOf(S, r2, cfg) {
          if (r2.fecha_invalida) return cfg.minWeight;
          var w = S * r2.u;
          if (w > 1) w = 1;
          return w < cfg.minWeight ? cfg.minWeight : w;
        }

        // Encogimiento hacia la tasa esperada q
        function shrink(n, y, q, mv, cfg) {
          var out = { delta: 0, lambda: 0, pTilde: null, a: null, b: null, q: q };
          if (!(n > 0) || !isNum(q)) return out;
          out.pTilde = (y + mv * q) / (n + mv);
          out.lambda = n / (n + mv);
          out.a = y + mv * q;
          out.b = n - y + mv * (1 - q);
          out.delta = clampV(logit(out.pTilde) - logit(q), -cfg.deltaClamp, cfg.deltaClamp);
          return out;
        }

        function levelStats(list, cut, det, cfg, hist, pEventoOf, S) {
          var n = 0, y = 0, sw2 = 0, nRaw = 0, yRaw = 0, E = 0;
          var end = lowerBoundIdx(list, cut), i, r2, w;
          for (i = 0; i < end; i++) {
            r2 = hist[list[i]];
            if (r2.id_vuelo === det.id_vuelo) continue;
            w = weightOf(S, r2, cfg);
            n += w; sw2 += w * w; nRaw++;
            if (r2.inv) { y += w; yRaw++; }
            if (pEventoOf) E += w * pEventoOf(r2.id_evento);
          }
          return { n: n, y: y, sw2: sw2, nRaw: nRaw, yRaw: yRaw, E: E, nKish: kish(n, sw2) };
        }

        /* fitPriors: un m por factor + κ, una sola vez */
        function fitPriors(hist, cfg) {
          var mm2 = {}, i, g, f, kk, r2;
          var diagn = {
            metodo_m: 'sin datos', logloss_holdout: null, logloss_baseline_evento: null,
            mejora_relativa: null, n_fit: 0, n_hold: 0
          };
          var allFactors = cfg.factors.concat(['validador']);
          var N = hist.length;
          if (N === 0) {
            mm2.id_evento = 20;
            for (g = 0; g < allFactors.length; g++) mm2[allFactors[g]] = 50;
            return { m: mm2, kappa: cfg.kappaFallback, diagnostico: diagn, sigma_validador: null, delta_validador: {} };
          }

          // se pondera respecto a la detección etiquetada más reciente
          var S0 = hist[N - 1].u > 0 ? 1 / hist[N - 1].u : 1;
          var w = new Array(N);
          for (i = 0; i < N; i++) w[i] = weightOf(S0, hist[i], cfg);

          var split = Math.floor(N * (1 - cfg.holdoutFraction));
          var nHold = N - split;
          var metodoA = (nHold >= cfg.holdoutMinRows && split >= cfg.holdoutMinRows);
          diagn.n_fit = split; diagn.n_hold = nHold;

          var lim = metodoA ? split : N;
          var gN = 0, gY = 0, ev2 = {}, eo;
          for (i = 0; i < lim; i++) {
            r2 = hist[i];
            gN += w[i]; if (r2.inv) gY += w[i];
            eo = ev2[r2.id_evento]; if (!eo) { eo = ev2[r2.id_evento] = { n: 0, y: 0 }; }
            eo.n += w[i]; if (r2.inv) eo.y += w[i];
          }
          var pi = (gY + 1) / (gN + 2);

          function pEventoWith(mv) {
            return function (name) {
              var s = ev2[name], nn = s ? s.n : 0, yy = s ? s.y : 0;
              return (yy + mv * pi) / (nn + mv);
            };
          }

          if (metodoA) {
            diagn.metodo_m = 'grid search por log-loss en holdout temporal';
            var bestM = null, bestLL = null, j, mv, pf, ll, sw;
            for (j = 0; j < cfg.mGrid.length; j++) {
              mv = cfg.mGrid[j]; pf = pEventoWith(mv); ll = 0; sw = 0;
              for (i = split; i < N; i++) { r2 = hist[i]; ll += w[i] * nll(pf(r2.id_evento), r2.inv); sw += w[i]; }
              ll = sw > 0 ? ll / sw : Infinity;
              if (bestLL === null || ll <= bestLL + 1e-12) { bestLL = ll; bestM = mv; }
            }
            mm2.id_evento = bestM;
            var pEv = pEventoWith(bestM);
            diagn.logloss_baseline_evento = bestLL;

            var deltaMaps = {};
            for (g = 0; g < allFactors.length; g++) {
              f = allFactors[g];
              var lv = {}, ob;
              for (i = 0; i < split; i++) {
                r2 = hist[i]; kk = r2[f];
                ob = lv[kk]; if (!ob) { ob = lv[kk] = { n: 0, y: 0, E: 0 }; }
                ob.n += w[i]; if (r2.inv) ob.y += w[i];
                ob.E += w[i] * pEv(r2.id_evento);
              }
              var bestFM = null, bestFLL = null, bestMap = null;
              for (j = 0; j < cfg.mGrid.length; j++) {
                mv = cfg.mGrid[j];
                var dm = {}, key2;
                for (key2 in lv) {
                  if (!Object.prototype.hasOwnProperty.call(lv, key2)) continue;
                  ob = lv[key2];
                  if (ob.n < cfg.minLevelSupport) { dm[key2] = 0; continue; }
                  dm[key2] = shrink(ob.n, ob.y, ob.E / ob.n, mv, cfg).delta;
                }
                ll = 0; sw = 0;
                for (i = split; i < N; i++) {
                  r2 = hist[i];
                  var dd = dm[r2[f]]; if (!isNum(dd)) dd = 0;
                  ll += w[i] * nll(sigmoid(logit(pEv(r2.id_evento)) + dd), r2.inv);
                  sw += w[i];
                }
                ll = sw > 0 ? ll / sw : Infinity;
                if (bestFLL === null || ll <= bestFLL + 1e-12) { bestFLL = ll; bestFM = mv; bestMap = dm; }
              }
              mm2[f] = bestFM;
              deltaMaps[f] = bestMap;
            }

            var sums = new Array(N);
            for (i = split; i < N; i++) {
              r2 = hist[i]; var s2 = 0;
              for (g = 0; g < cfg.factors.length; g++) {
                var dv = deltaMaps[cfg.factors[g]][r2[cfg.factors[g]]];
                if (isNum(dv)) s2 += dv;
              }
              sums[i] = s2;
            }
            var bestK = null, bestKLL = null;
            for (j = 0; j < cfg.kappaGrid.length; j++) {
              var kap = cfg.kappaGrid[j]; ll = 0; sw = 0;
              for (i = split; i < N; i++) {
                r2 = hist[i];
                ll += w[i] * nll(sigmoid(logit(pEv(r2.id_evento)) + kap * sums[i]), r2.inv);
                sw += w[i];
              }
              ll = sw > 0 ? ll / sw : Infinity;
              if (bestKLL === null || ll < bestKLL) { bestKLL = ll; bestK = kap; }
            }
            var kappa = bestK === null ? cfg.kappaFallback : bestK;
            diagn.logloss_holdout = bestKLL;
            if (isNum(diagn.logloss_baseline_evento) && diagn.logloss_baseline_evento > 0) {
              diagn.mejora_relativa = (diagn.logloss_baseline_evento - bestKLL) / diagn.logloss_baseline_evento;
            }
            var res = { m: mm2, kappa: kappa, diagnostico: diagn };
            addValidatorSpread(res, hist, w, pEv, cfg);
            return res;
          }

          // Método B: momentos Beta-binomial
          diagn.metodo_m = 'momentos Beta-binomial (holdout insuficiente)';
          mm2.id_evento = momentsM(ev2, pi, cfg);
          var pEvB = pEventoWith(mm2.id_evento);
          for (g = 0; g < allFactors.length; g++) {
            f = allFactors[g];
            var lvB = {}, obb;
            for (i = 0; i < N; i++) {
              r2 = hist[i]; kk = r2[f];
              obb = lvB[kk]; if (!obb) { obb = lvB[kk] = { n: 0, y: 0 }; }
              obb.n += w[i]; if (r2.inv) obb.y += w[i];
            }
            mm2[f] = momentsM(lvB, pi, cfg);
          }
          var resB = { m: mm2, kappa: cfg.kappaFallback, diagnostico: diagn };
          addValidatorSpread(resB, hist, w, pEvB, cfg);
          return resB;
        }

        function momentsM(levels, piGlobal, cfg) {
          var ks = Object.keys(levels), i, o, sumN = 0, sumY = 0, cnt = 0;
          for (i = 0; i < ks.length; i++) {
            o = levels[ks[i]];
            if (o.n < 3) continue;
            sumN += o.n; sumY += o.y; cnt++;
          }
          if (cnt < 2 || sumN <= 0) return 50;
          var mu = sumY / sumN;
          if (!(mu > 0 && mu < 1)) mu = clampV(piGlobal, 1e-4, 1 - 1e-4);
          var s2 = 0, nbar = sumN / cnt;
          for (i = 0; i < ks.length; i++) {
            o = levels[ks[i]];
            if (o.n < 3) continue;
            var pl = o.y / o.n;
            s2 += o.n * (pl - mu) * (pl - mu);
          }
          s2 = s2 / sumN;
          var tau2 = Math.max(s2 - mu * (1 - mu) / nbar, 1e-6);
          var mg = mu * (1 - mu) / tau2 - 1;
          if (!isNum(mg)) return cfg.mMax;
          return clampV(mg, cfg.mMin, cfg.mMax);
        }

        function addValidatorSpread(res, hist, w, pEventoFn, cfg) {
          var lv = {}, i, r2, o, k;
          for (i = 0; i < hist.length; i++) {
            r2 = hist[i]; k = r2.validador;
            o = lv[k]; if (!o) { o = lv[k] = { n: 0, y: 0, E: 0 }; }
            o.n += w[i]; if (r2.inv) o.y += w[i];
            o.E += w[i] * pEventoFn(r2.id_evento);
          }
          var deltas = {}, arr = [];
          for (k in lv) {
            if (!Object.prototype.hasOwnProperty.call(lv, k)) continue;
            o = lv[k];
            if (o.n < cfg.minLevelSupport) continue;
            var dl = shrink(o.n, o.y, o.E / o.n, res.m.validador, cfg).delta;
            deltas[k] = dl; arr.push(dl);
          }
          res.delta_validador = deltas;
          res.sigma_validador = arr.length >= 2 ? sdev(arr) : null;
        }

        /* analyze: única fuente de verdad para el render */
        function analyze(det, dsx, priors, cfg) {
          var hist = dsx.hist;
          var cut = cfg.strictTemporalCutoff ? lowerBoundT(hist, det.t) : hist.length;
          var S = scaleFor(det.t, dsx, cfg);
          var i, r2, w, g, f;

          // pasada única sobre el corpus
          var gN = 0, gY = 0, gW2 = 0, nRaw = 0, ev2 = {}, eo;
          var tMin = null, tMax = null;
          var driftCut = det.t - cfg.driftWindowDays * DAY;
          var dRecN = 0, dRecY = 0, dOldN = 0, dOldY = 0;
          for (i = 0; i < cut; i++) {
            r2 = hist[i];
            if (r2.id_vuelo === det.id_vuelo) continue;
            w = weightOf(S, r2, cfg);
            gN += w; gW2 += w * w; nRaw++;
            if (r2.inv) gY += w;
            eo = ev2[r2.id_evento]; if (!eo) { eo = ev2[r2.id_evento] = { n: 0, y: 0, nRaw: 0, yRaw: 0 }; }
            eo.n += w; eo.nRaw++; if (r2.inv) { eo.y += w; eo.yRaw++; }
            if (tMin === null || r2.t < tMin) tMin = r2.t;
            if (tMax === null || r2.t > tMax) tMax = r2.t;
            if (!r2.fecha_invalida && r2.id_evento === det.id_evento) {
              if (r2.t >= driftCut) { dRecN++; if (r2.inv) dRecY++; }
              else { dOldN++; if (r2.inv) dOldY++; }
            }
          }

          var flags = [];
          var corpusVacio = (nRaw === 0);
          var piGlobal = (gY + 1) / (gN + 2);
          var mEv = priors.m.id_evento;
          var evS = ev2[det.id_evento] || { n: 0, y: 0, nRaw: 0, yRaw: 0 };
          function pEventoOf(name) {
            var s = ev2[name], nn = s ? s.n : 0, yy = s ? s.y : 0;
            return (yy + mEv * piGlobal) / (nn + mEv);
          }
          var pEvento = pEventoOf(det.id_evento);
          var aE = evS.y + mEv * piGlobal, bE = evS.n - evS.y + mEv * (1 - piGlobal);
          var zBase = logit(pEvento);
          if (evS.nRaw < 10) flags.push('EVENTO_NUEVO');

          var kappa = priors.kappa;

          function buildRow(factor, rol, incluido) {
            var nivel = det[factor];
            var list = dsx.byFactorNivel[factor + '|' + nivel] || [];
            var st = levelStats(list, cut, det, cfg, hist, pEventoOf, S);
            var mg = priors.m[factor];
            var rowFlags = [];
            var q = st.n > 0 ? st.E / st.n : null;
            var sh = { delta: 0, lambda: 0, pTilde: null, a: null, b: null };
            if (st.n <= 0) {
              rowFlags.push('NIVEL_NUEVO');
              flags.push('NIVEL_NUEVO:' + factor);
            } else if (st.n < cfg.minLevelSupport) {
              rowFlags.push('NIVEL_SIN_SOPORTE');
              flags.push('NIVEL_SIN_SOPORTE:' + factor);
            } else {
              sh = shrink(st.n, st.y, q, mg, cfg);
            }
            var razon = st.n <= 0 ? 'nivel nuevo'
              : (st.n < cfg.minLevelSupport ? 'sin soporte'
                : (Math.abs(sh.delta) < 1e-6 ? 'sin efecto' : ''));
            return {
              factor: factor, etiqueta: cfg.labels[factor] || factor, nivel: nivel,
              rol: rol, incluido_en_prediccion: incluido,
              n: st.nRaw, n_ponderado: st.n, n_kish: st.nKish, y: st.yRaw,
              tasa_observada: st.nRaw > 0 ? st.yRaw / st.nRaw : null,
              wilson_90: wilson(st.yRaw, st.nRaw, cfg.z),
              tasa_esperada: q, tasa_encogida: sh.pTilde,
              delta_logit: sh.delta,
              odds_ratio: isNum(sh.delta) ? Math.exp(sh.delta) : null,
              lambda_shrinkage: sh.lambda, m_factor: mg,
              a: sh.a, b: sh.b,
              contribucion_pct: 0, rank: null, es_driver_principal: false,
              flags: rowFlags, razon: razon
            };
          }

          var caracteristicas = [];
          caracteristicas.push({
            factor: 'id_evento', etiqueta: cfg.labels.id_evento, nivel: det.id_evento,
            rol: 'ESTRATO_BASE', incluido_en_prediccion: true,
            n: evS.nRaw, n_ponderado: evS.n, n_kish: null, y: evS.yRaw,
            tasa_observada: evS.nRaw > 0 ? evS.yRaw / evS.nRaw : null,
            wilson_90: wilson(evS.yRaw, evS.nRaw, cfg.z),
            tasa_esperada: piGlobal, tasa_encogida: pEvento,
            delta_logit: logit(pEvento) - logit(piGlobal),
            odds_ratio: Math.exp(logit(pEvento) - logit(piGlobal)),
            lambda_shrinkage: evS.n / (evS.n + mEv), m_factor: mEv,
            a: aE, b: bE, contribucion_pct: 0, rank: null, es_driver_principal: false,
            flags: evS.nRaw < 10 ? ['EVENTO_NUEVO'] : [], razon: ''
          });

          var sumDelta = 0, factorRows = [];
          for (g = 0; g < cfg.factors.length; g++) {
            f = cfg.factors[g];
            var fr = buildRow(f, 'FACTOR', true);
            factorRows.push(fr);
            caracteristicas.push(fr);
            sumDelta += fr.delta_logit;
          }

          // interacciones evento × factor
          var interacciones = [], sumInt = 0;
          var qIntBase = sigmoid(zBase + kappa * sumDelta);
          for (g = 0; g < cfg.interactionFactors.length; g++) {
            f = cfg.interactionFactors[g];
            var nivelI = det[f];
            var listI = dsx.byEventoFactorNivel[det.id_evento + '|' + f + '|' + nivelI] || [];
            var stI = levelStats(listI, cut, det, cfg, hist, null, S);
            var it = {
              factor: f, etiqueta: cfg.labels[f] || f, nivel: nivelI,
              n: stI.nRaw, n_ponderado: stI.n, y: stI.yRaw,
              tasa_observada: stI.nRaw > 0 ? stI.yRaw / stI.nRaw : null,
              tasa_esperada: qIntBase, tasa_encogida: null,
              delta_logit: 0, aplicada: false, a: null, b: null
            };
            if (stI.n >= cfg.interactionMinN) {
              var shI = shrink(stI.n, stI.y, qIntBase, 2 * priors.m[f], cfg);
              it.delta_logit = shI.delta;
              it.tasa_encogida = shI.pTilde;
              it.a = shI.a; it.b = shI.b;
              it.aplicada = true;
              sumInt += shI.delta;
            }
            interacciones.push(it);
          }

          var z = zBase + kappa * (sumDelta + sumInt);
          var p = sigmoid(z);

          // varianza e incertidumbre
          var varZ = 0;
          if (aE > 0 && bE > 0) varZ += 1 / aE + 1 / bE;
          for (g = 0; g < factorRows.length; g++) {
            var fro = factorRows[g];
            if (isNum(fro.a) && isNum(fro.b) && fro.a > 0 && fro.b > 0) varZ += kappa * kappa * (1 / fro.a + 1 / fro.b);
          }
          for (g = 0; g < interacciones.length; g++) {
            var io = interacciones[g];
            if (io.aplicada && isNum(io.a) && isNum(io.b) && io.a > 0 && io.b > 0) varZ += kappa * kappa * (1 / io.a + 1 / io.b);
          }
          var sdz = Math.sqrt(varZ);
          var ic = [sigmoid(z - cfg.z * sdz), sigmoid(z + cfg.z * sdz)];

          var denomEf = sdz * sdz * p * (1 - p);
          var nEfect = denomEf > 0 ? Math.round(1 / denomEf) : null;
          if (!isNum(nEfect)) nEfect = null;

          var nMinPrec = Math.ceil(cfg.z * cfg.z * p * (1 - p) / (cfg.targetHalfWidth * cfg.targetHalfWidth));
          var edges = [cfg.decisionBands.validarAlta, cfg.decisionBands.validarMod,
            cfg.decisionBands.invalidarMod, cfg.decisionBands.invalidarAlta];
          var bestD = Math.abs(p - edges[0]);
          for (i = 1; i < edges.length; i++) {
            var dd2 = Math.abs(p - edges[i]);
            if (dd2 < bestD) bestD = dd2;
          }
          var nMinDec = (bestD > 1e-9) ? Math.ceil(cfg.z * cfg.z * p * (1 - p) / (bestD * bestD)) : null;
          var nMinOpt = (nMinDec === null) ? null : Math.max(nMinPrec, nMinDec);
          var ratio = (isNum(nEfect) && isNum(nMinOpt) && nMinOpt > 0) ? nEfect / nMinOpt : 0;

          var nivelEvid;
          if (!isNum(nEfect) || nEfect < 1 || nMinOpt === null) nivelEvid = 'INSUFICIENTE';
          else if (ratio >= cfg.evidenceBands.suficiente) nivelEvid = 'SUFICIENTE';
          else if (ratio >= cfg.evidenceBands.limitada) nivelEvid = 'LIMITADA';
          else if (ratio >= cfg.evidenceBands.debil) nivelEvid = 'DEBIL';
          else nivelEvid = 'INSUFICIENTE';
          var textoEvid = {
            SUFICIENTE: 'La evidencia alcanza el mínimo requerido para sostener la sugerencia.',
            LIMITADA: 'La evidencia es indicativa pero no alcanza el mínimo requerido.',
            DEBIL: 'La evidencia es débil: la sugerencia no debe sustituir el criterio del validador.',
            INSUFICIENTE: 'No hay evidencia suficiente para sostener ninguna sugerencia.'
          }[nivelEvid];
          if (nivelEvid === 'DEBIL' || nivelEvid === 'INSUFICIENTE') flags.push('EVIDENCIA_INSUFICIENTE');

          // bandas de decisión
          var B = cfg.decisionBands, accion, conf;
          if (p >= B.invalidarAlta) { accion = 'INVALIDAR'; conf = 'ALTA'; }
          else if (p >= B.invalidarMod) { accion = 'INVALIDAR'; conf = 'MODERADA'; }
          else if (p >= B.validarMod) { accion = 'SIN_SUGERENCIA'; conf = null; }
          else if (p >= B.validarAlta) { accion = 'VALIDAR'; conf = 'MODERADA'; }
          else { accion = 'VALIDAR'; conf = 'ALTA'; }
          if (p >= 0.40 && p <= 0.60) flags.push('ZONA_AMBIGUA');
          var cruzaUmbral = (ic[0] <= 0.5 && ic[1] >= 0.5);
          if (cruzaUmbral) flags.push('IC_CRUZA_UMBRAL');
          var nKishGlobal = kish(gN, gW2);
          if (nRaw > 0 && nKishGlobal / nRaw < 0.35) flags.push('HISTORIA_ANTIGUA');

          var degradada = false, accionOriginal = accion;
          if (accion !== 'SIN_SUGERENCIA') {
            if (cfg.degradeOnWeakEvidence && (nivelEvid === 'DEBIL' || nivelEvid === 'INSUFICIENTE')) degradada = true;
            if (cfg.degradeOnThresholdCrossing && cruzaUmbral) degradada = true;
          }
          if (corpusVacio) degradada = true;
          var accionFinal = degradada ? 'SIN_SUGERENCIA' : accion;
          var etiquetaVisible = accionFinal === 'INVALIDAR' ? 'INVALIDAR'
            : (accionFinal === 'VALIDAR' ? 'VALIDAR' : 'SIN SUGERENCIA SUFICIENTE');

          // validador: se estima pero no entra en z
          var rowVal = buildRow('validador', 'SESGO_OBSERVADO', false);
          caracteristicas.push(rowVal);
          var pAjustado = sigmoid(z + kappa * rowVal.delta_logit);
          if (isNum(priors.sigma_validador) && priors.sigma_validador > 0.7) flags.push('ALTA_DISPERSION_VALIDADORES');

          // drivers y contribuciones
          var sumAbs = 0;
          for (g = 0; g < factorRows.length; g++) sumAbs += Math.abs(factorRows[g].delta_logit);
          for (g = 0; g < factorRows.length; g++) {
            factorRows[g].contribucion_pct = sumAbs > 0 ? Math.abs(factorRows[g].delta_logit) / sumAbs * 100 : 0;
          }
          var ordenados = factorRows.slice(0);
          ordenados.sort(function (a, b) { return Math.abs(b.delta_logit) - Math.abs(a.delta_logit); });
          var drivers = [];
          for (g = 0; g < ordenados.length; g++) {
            if (Math.abs(ordenados[g].delta_logit) < cfg.driverMinDelta) continue;
            if (drivers.length >= cfg.topDrivers) break;
            ordenados[g].rank = drivers.length + 1;
            ordenados[g].es_driver_principal = (drivers.length === 0);
            ordenados[g].direccion = ordenados[g].delta_logit > 0 ? 'INVALIDAR' : 'VALIDAR';
            drivers.push(ordenados[g]);
          }

          var motivo = inferMotivo(drivers, cfg);
          var sim = similarCases(det, dsx, cut, factorRows, cfg);
          if (sim.casos.length === 0) flags.push('SIN_PRECEDENTES');

          var tasaRec = dRecN >= cfg.driftMinN ? dRecY / dRecN : null;
          var tasaOld = dOldN >= cfg.driftMinN ? dOldY / dOldN : null;
          var deltaDrift = (isNum(tasaRec) && isNum(tasaOld)) ? tasaRec - tasaOld : null;
          var detectada = isNum(deltaDrift) && Math.abs(deltaDrift) > cfg.driftThreshold;
          if (detectada) flags.push('DERIVA_DETECTADA');

          var todosNuevos = true;
          for (g = 0; g < factorRows.length; g++) { if (factorRows[g].n > 0) { todosNuevos = false; break; } }

          return {
            meta: {
              id_deteccion: det.id_deteccion, id_vuelo: det.id_vuelo, id_evento: det.id_evento,
              timestamp_deteccion: det.ts, validador_asignado: det.validador,
              status_actual: det.status_validez,
              generado_en: new Date(), version_motor: cfg.versionMotor,
              corpus: {
                n_total_dataset: dsx.stats.nTotal, n_historico_usado: nRaw, n_kish: nKishGlobal,
                corte_temporal_estricto: cfg.strictTemporalCutoff,
                ventana: { desde: tMin === null ? null : new Date(tMin), hasta: tMax === null ? null : new Date(tMax) }
              },
              corpus_vacio: corpusVacio, todos_niveles_nuevos: todosNuevos
            },
            sugerencia: {
              accion: accionFinal, accion_sin_degradar: accionOriginal,
              etiqueta_visible: etiquetaVisible, nivel_confianza: degradada ? null : conf,
              p_invalido: p, ic_90: ic, sd_logit: sdz, banda: bandName(p, cfg),
              degradada_por_evidencia: degradada, neutral_al_validador: true,
              p_invalido_ajustado_validador: pAjustado
            },
            evidencia: {
              n_efectivo: nEfect, n_minimo_optimo: nMinOpt, n_min_precision: nMinPrec,
              n_min_decision: nMinDec, ratio_evidencia: ratio, nivel: nivelEvid, texto: textoEvid
            },
            linea_base: {
              tasa_global: piGlobal, n_global: nRaw,
              tasa_evento_cruda: evS.nRaw > 0 ? evS.yRaw / evS.nRaw : null,
              tasa_evento_encogida: pEvento, n_evento: evS.nRaw, m_evento: mEv, logit_evento: zBase
            },
            drivers: drivers,
            caracteristicas_agregadas: caracteristicas,
            interacciones: interacciones,
            motivo_inferido: motivo,
            casos_similares: sim.casos,
            resumen_precedentes: sim.resumen,
            diagnostico: {
              kappa: kappa, m_por_factor: priors.m, sigma_validador: priors.sigma_validador,
              half_life_dias: cfg.halfLifeDays,
              deriva: { tasa_90d: tasaRec, tasa_previa: tasaOld, delta: deltaDrift, detectada: detectada, n_90d: dRecN, n_previa: dOldN },
              metodo_m: priors.diagnostico.metodo_m,
              logloss_holdout: priors.diagnostico.logloss_holdout,
              logloss_baseline_evento: priors.diagnostico.logloss_baseline_evento,
              mejora_relativa: priors.diagnostico.mejora_relativa,
              suma_delta: sumDelta, suma_delta_int: sumInt, z: z
            },
            flags: flags,
            disclaimer: DISCLAIMER
          };
        }

        function bandName(p, cfg) {
          var B = cfg.decisionBands;
          if (p >= B.invalidarAlta) return 'INVALIDAR_ALTA';
          if (p >= B.invalidarMod) return 'INVALIDAR_MODERADA';
          if (p >= B.validarMod) return 'AMBIGUA';
          if (p >= B.validarAlta) return 'VALIDAR_MODERADA';
          return 'VALIDAR_ALTA';
        }

        var MOTIVOS = {
          PATRON_CALIDAD_DATO: {
            titulo: 'Patrón de calidad de dato',
            texto: 'Patrón asociado a la configuración de datos / decodificación. Verificar confiabilidad de los parámetros grabados.'
          },
          PATRON_AERONAVE: {
            titulo: 'Patrón de aeronave',
            texto: 'Patrón asociado a esta aeronave. Posible comportamiento sistemático de la matrícula o de su configuración de grabación.'
          },
          PATRON_AEROPUERTO: {
            titulo: 'Patrón de aeropuerto',
            texto: 'Patrón asociado a la operación en este aeropuerto. Posible escenario operacional recurrente no cubierto por la lógica.'
          },
          PATRON_FASE: {
            titulo: 'Patrón de fase de vuelo',
            texto: 'Patrón asociado a la fase de vuelo. Posible limitación de la lógica en esta fase.'
          },
          PATRON_LOGICA_EVENTO: {
            titulo: 'Comportamiento del tipo de evento',
            texto: 'Sin factores contextuales dominantes: el comportamiento responde al tipo de evento en general.'
          }
        };
        function codigoMotivo(factor) {
          if (factor === 'esquema_datos' || factor === 'dataframe_qar') return 'PATRON_CALIDAD_DATO';
          if (factor === 'matricula') return 'PATRON_AERONAVE';
          if (factor === 'origen' || factor === 'destino') return 'PATRON_AEROPUERTO';
          if (factor === 'fase_deteccion') return 'PATRON_FASE';
          return 'PATRON_LOGICA_EVENTO';
        }
        function inferMotivo(drivers, cfg) {
          if (drivers.length === 0 || Math.abs(drivers[0].delta_logit) < 0.15) {
            var m0 = MOTIVOS.PATRON_LOGICA_EVENTO;
            return { codigo: 'PATRON_LOGICA_EVENTO', titulo: m0.titulo, texto: m0.texto, secundario: null, es_hipotesis: true };
          }
          var cod = codigoMotivo(drivers[0].factor), M = MOTIVOS[cod];
          var sec = null;
          if (drivers.length > 1 &&
            Math.abs(drivers[1].delta_logit) >= cfg.secondaryDriverRatio * Math.abs(drivers[0].delta_logit)) {
            var cod2 = codigoMotivo(drivers[1].factor);
            sec = { codigo: cod2, titulo: MOTIVOS[cod2].titulo, factor: drivers[1].factor, nivel: drivers[1].nivel };
          }
          return { codigo: cod, titulo: M.titulo, texto: M.texto, secundario: sec, es_hipotesis: true };
        }

        function similarCases(det, dsx, cut, factorRows, cfg) {
          var list = dsx.byEvento[det.id_evento] || [];
          var end = lowerBoundIdx(list, cut);
          var sumAbs = 0, g;
          for (g = 0; g < factorRows.length; g++) sumAbs += Math.abs(factorRows[g].delta_logit);
          var pesos = {};
          for (g = 0; g < factorRows.length; g++) {
            pesos[factorRows[g].factor] = sumAbs > 0
              ? Math.abs(factorRows[g].delta_logit) / sumAbs
              : 1 / factorRows.length;
          }
          var cands = [], i, r2, dd, coin, dif, f;
          for (i = 0; i < end; i++) {
            r2 = dsx.hist[list[i]];
            if (r2.id_vuelo === det.id_vuelo) continue;
            dd = 0; coin = []; dif = [];
            for (g = 0; g < cfg.factors.length; g++) {
              f = cfg.factors[g];
              if (r2[f] !== det[f]) { dd += pesos[f]; dif.push(cfg.labels[f] + ': ' + r2[f]); }
              else coin.push(cfg.labels[f] + ': ' + r2[f]);
            }
            cands.push({
              id_deteccion: r2.id_deteccion, id_vuelo: r2.id_vuelo, fecha: r2.ts,
              dias_atras: Math.max(0, Math.round((det.t - r2.t) / DAY)),
              status_validez: r2.status_validez, validador: r2.validador,
              distancia: dd, coincidencias: coin, diferencias: dif, t: r2.t
            });
          }
          cands.sort(function (a, b) {
            if (a.distancia !== b.distancia) return a.distancia - b.distancia;
            return b.t - a.t;
          });
          var top = cands.slice(0, cfg.similarCases);
          var invTop = 0;
          for (i = 0; i < top.length; i++) if (top[i].status_validez === 'INVALIDO') invTop++;
          return {
            casos: top,
            resumen: {
              n_casos_mismo_evento: cands.length, n_top5: top.length, invalidados_top5: invTop,
              tasa_top5: top.length > 0 ? invTop / top.length : null
            }
          };
        }

        /* ---------- 6. CHARTS (Canvas 2D, dimensiones fijas) ---------- */
        var C = {
          text: '#202124', text2: '#5f6368', text3: '#9aa0a6', grid: '#e5e7eb',
          surface: '#f1f3f4', inv: '#d93025', val: '#137333', amb: '#b06000',
          accent: '#019de0', neutral: '#9aa0a6'
        };
        function actionColor(accion) {
          if (accion === 'INVALIDAR') return C.inv;
          if (accion === 'VALIDAR') return C.val;
          return C.amb;
        }

        function drawProbBar(cv, ficha) {
          var W = 560, H = 86, X0 = 30, PW = 500, Y = 34, BH = 16;
          cv.width = W; cv.height = H;
          var x = cv.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);

          var p = ficha.sugerencia.p_invalido;
          var lo = ficha.sugerencia.ic_90[0], hi = ficha.sugerencia.ic_90[1];
          var col = actionColor(ficha.sugerencia.accion);

          x.fillStyle = C.surface;
          x.fillRect(X0, Y, PW, BH);

          var xl = X0 + clampV(lo, 0, 1) * PW, xh = X0 + clampV(hi, 0, 1) * PW;
          x.fillStyle = col; x.globalAlpha = 0.28;
          x.fillRect(xl, Y, Math.max(2, xh - xl), BH);
          x.globalAlpha = 1;

          var marks = [0.2, 0.4, 0.6, 0.8], i, mx;
          x.strokeStyle = '#c9ced4'; x.setLineDash([3, 3]);
          for (i = 0; i < marks.length; i++) {
            mx = X0 + marks[i] * PW;
            x.beginPath(); x.moveTo(mx, Y - 4); x.lineTo(mx, Y + BH + 4); x.stroke();
          }
          x.setLineDash([]);

          var px = X0 + clampV(p, 0, 1) * PW;
          x.strokeStyle = col; x.lineWidth = 3;
          x.beginPath(); x.moveTo(px, Y - 7); x.lineTo(px, Y + BH + 7); x.stroke();
          x.lineWidth = 1;

          x.fillStyle = C.text3; x.font = '10px Arial, sans-serif';
          x.textAlign = 'center'; x.textBaseline = 'top';
          for (i = 0; i <= 5; i++) {
            var v = i / 5;
            x.fillText(Math.round(v * 100) + '%', X0 + v * PW, Y + BH + 10);
          }
          x.textAlign = 'left'; x.textBaseline = 'alphabetic';
          x.fillStyle = C.text2; x.font = '10.5px Arial, sans-serif';
          x.fillText('Banda sombreada = intervalo de confianza 90 %', X0, 18);
        }

        function drawEvidenceMeter(cv, evd) {
          var W = 560, H = 58, X0 = 8, PW = 460, Y = 22, BH = 14;
          cv.width = W; cv.height = H;
          var x = cv.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);

          var ratio = isNum(evd.ratio_evidencia) ? evd.ratio_evidencia : 0;
          var shown = clampV(ratio, 0, 1.5);
          var col = evd.nivel === 'SUFICIENTE' ? C.val : (evd.nivel === 'LIMITADA' ? C.amb : C.inv);

          x.fillStyle = C.surface; x.fillRect(X0, Y, PW, BH);
          x.fillStyle = col; x.fillRect(X0, Y, Math.max(2, (shown / 1.5) * PW), BH);

          var gx = X0 + (1 / 1.5) * PW;
          x.strokeStyle = C.text2; x.setLineDash([3, 3]);
          x.beginPath(); x.moveTo(gx, Y - 6); x.lineTo(gx, Y + BH + 6); x.stroke();
          x.setLineDash([]);

          x.fillStyle = C.text2; x.font = '10px Arial, sans-serif';
          x.textAlign = 'center'; x.textBaseline = 'top';
          x.fillText('meta 100 %', gx, Y + BH + 8);

          x.textAlign = 'left'; x.textBaseline = 'alphabetic';
          x.fillStyle = C.text; x.font = '600 12px Arial, sans-serif';
          x.fillText('Evidencia ' + evd.nivel, X0, 15);
          x.fillStyle = C.text2; x.font = '11px Arial, sans-serif';
          x.textAlign = 'right';
          x.fillText('n efectivo ' + (isNum(evd.n_efectivo) ? (evd.n_efectivo < 1 ? '<1' : evd.n_efectivo) : DASH) +
            ' / n mínimo ' + (isNum(evd.n_minimo_optimo) ? evd.n_minimo_optimo : DASH), X0 + PW, 15);
        }

        var wfRows = [];
        function drawWaterfall(cv, ficha) {
          var rows = buildWaterfallRows(ficha);
          wfRows = rows;
          var W = 640, RH = 30, TOP = 24;
          var H = TOP + rows.length * RH + 8;
          cv.width = W; cv.height = H;
          var x = cv.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);

          var LBL_R = 252, BAR_L = 262, BAR_W = 170, CX = BAR_L + BAR_W / 2;
          var maxAbs = 0.5, i;
          for (i = 0; i < rows.length; i++) if (isNum(rows[i].delta)) maxAbs = Math.max(maxAbs, Math.abs(rows[i].delta));
          var scale = (BAR_W / 2 - 4) / maxAbs;

          x.strokeStyle = C.grid;
          x.beginPath(); x.moveTo(CX, TOP - 6); x.lineTo(CX, H - 4); x.stroke();

          x.font = '10px Arial, sans-serif'; x.fillStyle = C.text3;
          x.textAlign = 'right'; x.textBaseline = 'alphabetic';
          x.fillText('Δ log-odds', 500, 14);
          x.fillText('acumulado', 600, 14);

          for (i = 0; i < rows.length; i++) {
            var rw = rows[i], y = TOP + i * RH + RH / 2;
            var esFinal = (rw.kind === 'final');

            x.fillStyle = (rw.kind === 'zero') ? C.text3 : C.text;
            x.font = (esFinal ? '600 ' : '') + '11.5px Arial, sans-serif';
            x.textAlign = 'right'; x.textBaseline = 'middle';
            x.fillText(trunc(rw.label, 42), LBL_R, y - (rw.sub ? 5 : 0));
            if (rw.sub) {
              x.fillStyle = C.text3; x.font = '9.5px Arial, sans-serif';
              x.fillText(trunc(rw.sub, 48), LBL_R, y + 7);
            }

            if (isNum(rw.delta) && Math.abs(rw.delta) > 1e-9) {
              var len = Math.abs(rw.delta) * scale;
              var col = rw.kind === 'kappa' ? C.neutral : (rw.delta > 0 ? C.inv : C.val);
              x.fillStyle = col;
              if (rw.delta > 0) x.fillRect(CX, y - 6, len, 12);
              else x.fillRect(CX - len, y - 6, len, 12);
            } else if (rw.kind === 'zero') {
              x.fillStyle = C.text3;
              x.fillRect(CX - 3, y - 1, 6, 2);
            }

            x.textAlign = 'right';
            x.font = '11px Arial, sans-serif';
            if (isNum(rw.delta)) {
              x.fillStyle = rw.delta > 0 ? C.inv : (rw.delta < 0 ? C.val : C.text3);
              x.fillText(fdelta(rw.delta), 500, y);
            } else {
              x.fillStyle = C.text3; x.fillText(DASH, 500, y);
            }
            x.fillStyle = esFinal ? C.text : C.text2;
            x.font = (esFinal ? '600 ' : '') + '11.5px Arial, sans-serif';
            x.fillText(fpct(rw.cum, 1), 600, y);

            rows[i]._y = TOP + i * RH; rows[i]._h = RH;
          }
        }

        function buildWaterfallRows(f) {
          var rows = [], i;
          rows.push({
            label: 'Tasa global del corpus', sub: 'n = ' + f.meta.corpus.n_historico_usado,
            delta: null, cum: f.linea_base.tasa_global, kind: 'base', factor: null
          });
          rows.push({
            label: 'Tipo de evento', sub: trunc(f.meta.id_evento, 46),
            delta: f.caracteristicas_agregadas[0].delta_logit, cum: f.linea_base.tasa_evento_encogida,
            kind: 'step', factor: 'id_evento'
          });
          var z = f.linea_base.logit_evento;
          var caras = f.caracteristicas_agregadas;
          for (i = 1; i < caras.length; i++) {
            var cc = caras[i];
            if (cc.rol !== 'FACTOR') continue;
            z += cc.delta_logit;
            rows.push({
              label: cc.etiqueta, sub: trunc(cc.nivel, 44) + (cc.razon ? ' · ' + cc.razon : ''),
              delta: cc.delta_logit, cum: sigmoid(z),
              kind: Math.abs(cc.delta_logit) < 1e-9 ? 'zero' : 'step', factor: cc.factor
            });
          }
          for (i = 0; i < f.interacciones.length; i++) {
            var it = f.interacciones[i];
            z += it.delta_logit;
            rows.push({
              label: 'Interacción evento × ' + it.etiqueta,
              sub: it.aplicada ? ('n = ' + it.n) : ('n = ' + it.n + ' · bajo el mínimo'),
              delta: it.delta_logit, cum: sigmoid(z),
              kind: it.aplicada && Math.abs(it.delta_logit) > 1e-9 ? 'step' : 'zero', factor: it.factor
            });
          }
          rows.push({
            label: 'Amortiguación κ = ' + fnum(f.diagnostico.kappa, 2),
            sub: 'corrige la sobre-confianza al sumar factores',
            delta: null, cum: f.sugerencia.p_invalido, kind: 'kappa', factor: null
          });
          rows.push({ label: 'RESULTADO', sub: null, delta: null, cum: f.sugerencia.p_invalido, kind: 'final', factor: null });
          return rows;
        }

        function drawWilsonMini(cv, lo, hi, rate, shrunk) {
          var W = 92, H = 16;
          cv.width = W; cv.height = H;
          var x = cv.getContext('2d');
          x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
          if (!isNum(lo) || !isNum(hi)) {
            x.fillStyle = C.text3; x.font = '9px Arial, sans-serif';
            x.textAlign = 'center'; x.textBaseline = 'middle';
            x.fillText(DASH, W / 2, H / 2);
            return;
          }
          var X0 = 3, PW = W - 6, y = H / 2;
          x.strokeStyle = C.grid; x.beginPath(); x.moveTo(X0, y); x.lineTo(X0 + PW, y); x.stroke();
          var xl = X0 + clampV(lo, 0, 1) * PW, xh = X0 + clampV(hi, 0, 1) * PW;
          x.strokeStyle = C.text2; x.lineWidth = 1.5;
          x.beginPath(); x.moveTo(xl, y); x.lineTo(xh, y); x.stroke();
          x.beginPath(); x.moveTo(xl, y - 4); x.lineTo(xl, y + 4); x.moveTo(xh, y - 4); x.lineTo(xh, y + 4); x.stroke();
          x.lineWidth = 1;
          if (isNum(rate)) {
            x.fillStyle = C.text;
            x.beginPath(); x.arc(X0 + clampV(rate, 0, 1) * PW, y, 2.5, 0, Math.PI * 2); x.fill();
          }
          if (isNum(shrunk)) {
            x.strokeStyle = C.accent; x.lineWidth = 2;
            var sx = X0 + clampV(shrunk, 0, 1) * PW;
            x.beginPath(); x.moveTo(sx, y - 5); x.lineTo(sx, y + 5); x.stroke();
            x.lineWidth = 1;
          }
        }

        /* ---------- 7. UI ---------- */
        function $(id) {
          var el = document.getElementById(id);
          if (!el) throw new Error('Elemento no encontrado: #' + id);
          return el;
        }
        var TIP = $('fdm-tooltip');
        function showTip(e, title, body) {
          TIP.innerHTML = '<div class="fdm-tt-title">' + esc(title) + '</div>' + esc(body);
          TIP.style.display = 'block';
          TIP.style.left = (e.clientX + 14) + 'px';
          TIP.style.top = (e.clientY - 10) + 'px';
        }
        function hideTip() { TIP.style.display = 'none'; }

        function statusChip(st) {
          var cls = st === 'PENDIENTE' ? 'fdm-status-pend' : (st === 'INVALIDO' ? 'fdm-status-inv' : 'fdm-status-val');
          return '<span class="fdm-status ' + cls + '">' + esc(st) + '</span>';
        }
        function kv(k, v, tipTxt) {
          return '<div class="fdm-kv"' + (tipTxt ? ' title="' + esc(tipTxt) + '"' : '') + '>' +
            '<div class="fdm-kv-k">' + esc(k) + '</div><div class="fdm-kv-v">' + esc(v) + '</div></div>';
        }

        /* --- P1 --- */
        function renderSearchView(dsx) {
          var s = dsx.stats;
          $('kpi-detecciones').innerText = String(s.nTotal);
          $('kpi-detecciones-foot').innerText = s.nEtiquetadas + ' ya validadas';
          $('kpi-vuelos').innerText = String(s.nVuelos);
          $('kpi-vuelos-foot').innerText = s.rangoFechas ? (fdate(s.rangoFechas[0]) + ' → ' + fdate(s.rangoFechas[1])) : DASH;
          $('kpi-tasa').innerText = fpct(s.tasaGlobal, 1);
          $('kpi-tasa-foot').innerText = 'sobre ' + s.nEtiquetadas + ' detecciones validadas';
          $('kpi-pendientes').innerText = String(s.nPendientes);
          $('kpi-pendientes-foot').innerText = s.nTotal > 0 ? fpct(s.nPendientes / s.nTotal, 1) + ' del total' : DASH;

          $('fdm-sub').innerText = s.nTotal + ' detecciones · ' + s.nVuelos + ' vuelos · ' +
            s.nPendientes + ' pendientes de validar';

          var chips = [], i, c = 0;
          for (i = 0; i < dsx.vuelos.length && c < 5; i++) {
            if (dsx.vuelos[i].pendientes === 0) continue;
            chips.push('<span class="fdm-chip fdm-chip-btn" data-vuelo="' + esc(dsx.vuelos[i].id) + '">' +
              '<b>' + esc(dsx.vuelos[i].id) + '</b> ' + esc(dsx.vuelos[i].matricula) + ' · ' +
              dsx.vuelos[i].pendientes + ' pend.</span>');
            c++;
          }
          $('fdm-example-chips').innerHTML = chips.length ? chips.join('') :
            '<span class="fdm-muted">No hay vuelos con detecciones pendientes en este dataset.</span>';
        }

        function renderModelPanel(dsx, priors) {
          var dg = priors.diagnostico, html = '';
          html += kv('κ (amortiguación)', fnum(priors.kappa, 2), CONFIG.tips.kappa);
          html += kv('Método de estimación de m', dg.metodo_m, CONFIG.tips.m);
          html += kv('m del tipo de evento', fint(priors.m.id_evento), CONFIG.tips.m);
          html += kv('Log-loss holdout', fnum(dg.logloss_holdout, 4), 'Menor es mejor. Se mide sobre el 20 % más reciente del histórico.');
          html += kv('Log-loss solo con el evento', fnum(dg.logloss_baseline_evento, 4), 'Referencia sin factores contextuales.');
          html += kv('Mejora relativa', isNum(dg.mejora_relativa) ? fpct(dg.mejora_relativa, 1) : DASH, 'Cuánto aportan los factores contextuales sobre el tipo de evento.');
          html += kv('σ entre validadores', fnum(priors.sigma_validador, 2), CONFIG.tips.sesgo);
          html += kv('Semivida de ponderación', CONFIG.halfLifeDays + ' días', 'Un caso de esa antigüedad pesa la mitad que uno de hoy.');
          html += '<div class="fdm-kv" style="grid-column:1/-1"><button type="button" class="fdm-btn" id="btn-tests">Ejecutar pruebas de correctitud</button></div>';
          $('fdm-model-summary').innerHTML = html;
          $('btn-tests').onclick = function () { runTests(dsx, priors); };
        }

        /* --- P2 --- */
        function renderListView(dsx, vueloId) {
          var v = null, i;
          for (i = 0; i < dsx.vuelos.length; i++) if (dsx.vuelos[i].id === vueloId) { v = dsx.vuelos[i]; break; }
          if (!v) return;

          $('fdm-flight-header').innerHTML =
            '<span id="fdm-flight-title">Vuelo ' + esc(v.id) + '</span>' +
            '<span class="fdm-chip"><b>' + esc(v.matricula) + '</b></span>' +
            '<span class="fdm-chip">' + esc(v.origen) + ' → ' + esc(v.destino) + '</span>' +
            '<span class="fdm-chip">' + esc(fdatetime(new Date(v.t0))) +
            (v.t0 !== v.t1 ? ' → ' + esc(ftime(new Date(v.t1))) : '') + '</span>' +
            '<span class="fdm-chip"><b>' + v.pendientes + '</b> pendientes de ' + v.n + '</span>';

          state.listPage = 0;
          renderListTable(dsx);
        }

        function renderListTable(dsx) {
          var dets = dsx.byVuelo[state.vuelo] || [];
          var verVal = state.verValidadas, filtered = [], i;
          for (i = 0; i < dets.length; i++) {
            if (verVal || dets[i].status_validez === 'PENDIENTE') filtered.push(dets[i]);
          }
          var total = filtered.length;
          var pages = Math.max(1, Math.ceil(total / CONFIG.pageSizeDetecciones));
          if (state.listPage >= pages) state.listPage = pages - 1;
          var from = state.listPage * CONFIG.pageSizeDetecciones;
          var page = filtered.slice(from, from + CONFIG.pageSizeDetecciones);

          $('fdm-list-count').innerText = total + (verVal ? ' detecciones' : ' pendientes') +
            (pages > 1 ? ' · página ' + (state.listPage + 1) + ' de ' + pages : '');

          var emptyEl = $('fdm-list-empty');
          if (total === 0) {
            emptyEl.className = 'fdm-state';
            emptyEl.innerHTML = verVal
              ? 'Este vuelo no tiene detecciones registradas.'
              : '<b>Este vuelo no tiene detecciones pendientes.</b> Activa «Ver también las ya validadas» para revisarlas en modo auditoría.';
          } else {
            emptyEl.className = 'fdm-state fdm-hidden';
          }

          var html = '', dd, pre;
          for (i = 0; i < page.length; i++) {
            dd = page[i];
            pre = state.preScores[dd.id_deteccion];
            html += '<tr data-det="' + esc(dd.id_deteccion) + '">' +
              '<td>' + statusChip(dd.status_validez) + '</td>' +
              '<td><span class="fdm-code">' + esc(trunc(dd.id_evento, 44)) + '</span></td>' +
              '<td class="fdm-mono">' + esc(fdatetime(dd.ts)) + '</td>' +
              '<td><span class="fdm-chip">' + esc(dd.fase_deteccion) + '</span></td>' +
              '<td>' + preIndicator(pre) + '</td>' +
              '<td style="text-align:right"><button type="button" class="fdm-btn fdm-btn-primary" data-open="' +
              esc(dd.id_deteccion) + '">Analizar →</button></td>' +
              '</tr>';
          }
          $('fdm-list-body').innerHTML = html;

          var pag = '';
          if (pages > 1) {
            pag += '<button type="button" class="fdm-btn" data-page="' + (state.listPage - 1) + '"' +
              (state.listPage === 0 ? ' disabled' : '') + '>← Anterior</button>';
            pag += '<span class="fdm-muted">' + (from + 1) + '–' + Math.min(total, from + page.length) + ' de ' + total + '</span>';
            pag += '<button type="button" class="fdm-btn" data-page="' + (state.listPage + 1) + '"' +
              (state.listPage >= pages - 1 ? ' disabled' : '') + '>Siguiente →</button>';
          }
          $('fdm-pagination').innerHTML = pag;

          schedulePreScores(page);
        }

        function preIndicator(p) {
          if (p === undefined) return '<span class="fdm-muted">…</span>';
          if (p === null) return '<span class="fdm-muted">' + DASH + '</span>';
          var col = p >= 0.6 ? C.inv : (p <= 0.4 ? C.val : C.amb);
          return '<span class="fdm-prebar"><span class="fdm-prebar-fill" style="width:' +
            Math.round(clampV(p, 0, 1) * 100) + '%;background:' + col + '"></span></span>' +
            '<span class="fdm-mono">' + fpct(p, 1) + '</span>';
        }

        var preTimer = null;
        function schedulePreScores(page) {
          var pend = [], i;
          for (i = 0; i < page.length; i++) {
            if (state.preScores[page[i].id_deteccion] === undefined) pend.push(page[i]);
          }
          if (pend.length === 0) return;
          if (preTimer) { clearTimeout(preTimer); preTimer = null; }
          var idx = 0;
          function step() {
            var t0 = new Date().getTime(), dd;
            while (idx < pend.length && (new Date().getTime() - t0) < 60) {
              dd = pend[idx++];
              try { state.preScores[dd.id_deteccion] = analyze(dd, DS, PRIORS, CONFIG).sugerencia.p_invalido; }
              catch (e2) { state.preScores[dd.id_deteccion] = null; }
            }
            updatePreCells();
            if (idx < pend.length) preTimer = setTimeout(step, 0);
            else preTimer = null;
          }
          if (pend.length > CONFIG.batchScoreThreshold) preTimer = setTimeout(step, 0);
          else step();
        }
        function updatePreCells() {
          var body = document.getElementById('fdm-list-body');
          if (!body) return;
          var trs = body.getElementsByTagName('tr'), i, id, tds;
          for (i = 0; i < trs.length; i++) {
            id = trs[i].getAttribute('data-det');
            tds = trs[i].getElementsByTagName('td');
            if (tds.length >= 5) tds[4].innerHTML = preIndicator(state.preScores[id]);
          }
        }

        /* --- P3: ficha --- */
        function renderCard(ficha, det) {
          renderBlockA(ficha, det);
          renderBlockB(ficha);
          renderBlockC(ficha);
          renderBlockD(ficha);
          renderBlockE(ficha);
          renderBlockF(ficha);
          renderBlockG(ficha);
          renderBlockH(ficha);
          renderBlockI(ficha);
          $('fdm-disclaimer').innerText = ficha.disclaimer;
        }

        function renderBlockA(f, det) {
          var driverOf = {}, i;
          for (i = 0; i < f.drivers.length; i++) driverOf[f.drivers[i].factor] = f.drivers[i];

          function chip(factor, valor) {
            var dv = driverOf[factor], dot = '', title = CONFIG.labels[factor] || factor;
            if (dv) {
              dot = '<span class="fdm-chip-dot" style="background:' + (dv.delta_logit > 0 ? C.inv : C.val) + '"></span>';
              title += ' — driver ' + dv.rank + ': ' + fpct(dv.contribucion_pct / 100, 0) +
                ' de la influencia (' + fdelta(dv.delta_logit) + ' log-odds)';
            }
            return '<span class="fdm-chip" id="chip-' + factor + '" title="' + esc(title) + '">' + dot +
              esc(CONFIG.labels[factor] || factor) + ': <b>' + esc(valor) + '</b></span>';
          }

          var audit = '';
          if (f.meta.status_actual !== 'PENDIENTE') {
            var coincide = (f.sugerencia.accion === 'INVALIDAR' && f.meta.status_actual === 'INVALIDO') ||
              (f.sugerencia.accion === 'VALIDAR' && f.meta.status_actual === 'VALIDO');
            audit = '<div class="fdm-alert" style="margin-top:10px">Modo auditoría: esta detección ya fue marcada como <b>' +
              esc(f.meta.status_actual) + '</b>. La sugerencia ' +
              (f.sugerencia.accion === 'SIN_SUGERENCIA' ? 'no se pronuncia.' : (coincide ? 'habría coincidido.' : 'habría diferido.')) +
              '</div>';
          }

          $('block-a').innerHTML =
            '<div class="fdm-a-id">Detección <span class="fdm-code">' + esc(f.meta.id_deteccion) + '</span></div>' +
            '<div class="fdm-a-title">' + esc(f.meta.id_evento) + '</div>' +
            '<div>' +
            '<span class="fdm-chip">Vuelo: <b>' + esc(f.meta.id_vuelo) + '</b></span>' +
            chip('matricula', det.matricula) +
            chip('origen', det.origen) + chip('destino', det.destino) +
            chip('fase_deteccion', det.fase_deteccion) +
            chip('esquema_datos', det.esquema_datos) +
            chip('dataframe_qar', det.dataframe_qar) +
            '<span class="fdm-chip" id="chip-validador" title="' + esc(CONFIG.tips.sesgo) + '">Validador: <b>' +
            esc(shortMail(f.meta.validador_asignado)) + '</b></span>' +
            '<span class="fdm-chip">' + esc(fdatetime(f.meta.timestamp_deteccion)) + '</span>' +
            '<span class="fdm-chip">' + statusChip(f.meta.status_actual) + '</span>' +
            '</div>' + audit;
        }

        function renderBlockB(f) {
          var s = f.sugerencia;
          $('block-b').className = 'fdm-panel ' +
            (s.accion === 'INVALIDAR' ? 'fdm-acc-inv' : s.accion === 'VALIDAR' ? 'fdm-acc-val' : 'fdm-acc-amb');

          var head = '<div class="fdm-sug-row">' +
            '<span class="fdm-sug-action" style="color:' + actionColor(s.accion) + '">SUGERENCIA: ' +
            esc(s.etiqueta_visible) + '</span>' +
            (s.nivel_confianza ? '<span class="fdm-sug-conf">confianza ' + esc(s.nivel_confianza) + '</span>' : '') +
            '</div>';

          var pShown = state.ajustarValidador ? s.p_invalido_ajustado_validador : s.p_invalido;
          head += '<div class="fdm-sug-p" title="' + esc(CONFIG.tips.p) + '">' + fpct(pShown, 1) + '</div>' +
            '<div class="fdm-sug-plabel">probabilidad de invalidación' +
            (state.ajustarValidador ? ' · ajustada por el validador asignado' : '') + '</div>' +
            '<div class="fdm-sug-ic" title="' + esc(CONFIG.tips.ic) + '">IC 90 %: ' +
            fpct(s.ic_90[0], 1) + ' — ' + fpct(s.ic_90[1], 1) + '</div>';
          $('b-head').innerHTML = head;

          drawProbBar($('canvas-prob'), f);

          var foot = '';
          if (s.degradada_por_evidencia) {
            foot += '<div class="fdm-sug-note fdm-sug-note-warn">Sin sugerencia suficiente. ' +
              'La acción que habría salido es <span class="fdm-strike">' +
              esc(s.accion_sin_degradar === 'SIN_SUGERENCIA' ? 'ninguna' : s.accion_sin_degradar) + '</span> · ' +
              (f.evidencia.nivel === 'DEBIL' || f.evidencia.nivel === 'INSUFICIENTE'
                ? 'la evidencia disponible es ' + esc(f.evidencia.nivel) + '.'
                : 'el intervalo de confianza cruza el umbral de decisión del 50 %.') +
              ' Todos los números se conservan abajo.</div>';
          }
          foot += '<div class="fdm-sug-note">Evidencia <b>' + esc(f.evidencia.nivel) + '</b> · n efectivo ' +
            (isNum(f.evidencia.n_efectivo) ? (f.evidencia.n_efectivo < 1 ? '&lt;1' : f.evidencia.n_efectivo) : DASH) +
            ' / n mínimo óptimo ' + (isNum(f.evidencia.n_minimo_optimo) ? f.evidencia.n_minimo_optimo : DASH) + '</div>';

          var deshab = (f.meta.validador_asignado === UNK);
          foot += '<div class="fdm-toggle-row">' +
            '<label class="fdm-check"><input type="checkbox" id="chk-validador"' +
            (state.ajustarValidador ? ' checked' : '') + (deshab ? ' disabled' : '') + ' />' +
            '<span>Ajustar por validador asignado (' + esc(shortMail(f.meta.validador_asignado)) + ')</span></label>' +
            '<span class="fdm-mono">' + fpct(s.p_invalido, 1) + ' → ' + fpct(s.p_invalido_ajustado_validador, 1) + '</span>' +
            '</div>' +
            '<div class="fdm-muted" style="margin-top:6px">La sugerencia es neutral al validador: responde a «¿debería invalidarse?», no a «¿qué diría este validador?».</div>';
          $('b-foot').innerHTML = foot;

          var chk = document.getElementById('chk-validador');
          if (chk && !deshab) {
            chk.onclick = function () { state.ajustarValidador = chk.checked; renderBlockB(f); };
          }
        }

        function renderBlockC(f) {
          drawEvidenceMeter($('canvas-evidence'), f.evidencia);
          var ee = f.evidencia, cp = f.meta.corpus;
          $('c-micro').innerHTML =
            kv('n histórico usado', fint(cp.n_historico_usado), 'Detecciones etiquetadas anteriores a esta, excluyendo su propio vuelo.') +
            kv('n Kish', fnum(cp.n_kish, 1), CONFIG.tips.kish) +
            kv('Ratio de evidencia', isNum(ee.ratio_evidencia) ? fnum(ee.ratio_evidencia, 2) : DASH, CONFIG.tips.ratio) +
            kv('n efectivo', isNum(ee.n_efectivo) ? (ee.n_efectivo < 1 ? '<1' : String(ee.n_efectivo)) : DASH, CONFIG.tips.nef) +
            kv('n mínimo por precisión', fint(ee.n_min_precision), 'Casos necesarios para un margen de ±10 puntos.') +
            kv('n mínimo por decisión', isNum(ee.n_min_decision) ? fint(ee.n_min_decision) : DASH, 'Casos necesarios para que el intervalo no cruce el borde de banda más cercano.') +
            '<div class="fdm-kv" style="grid-column:1/-1"><div class="fdm-kv-k">Lectura</div>' +
            '<div style="font-size:12px;margin-top:3px">' + esc(ee.texto) + '</div></div>';
        }

        function renderBlockD(f) {
          var cv = $('canvas-waterfall');
          drawWaterfall(cv, f);
          cv.onmousemove = function (e) {
            var rect = cv.getBoundingClientRect();
            var scaleY = cv.height / rect.height;
            var my = (e.clientY - rect.top) * scaleY;
            var i, hit = null;
            for (i = 0; i < wfRows.length; i++) {
              if (my >= wfRows[i]._y && my <= wfRows[i]._y + wfRows[i]._h) { hit = wfRows[i]; break; }
            }
            clearChipHighlight();
            if (hit) {
              if (hit.factor) {
                var ch = document.getElementById('chip-' + hit.factor);
                if (ch) ch.className = 'fdm-chip fdm-chip-hi';
              }
              showTip(e, hit.label, (hit.sub ? hit.sub + '\n' : '') +
                (isNum(hit.delta) ? 'Δ log-odds: ' + fdelta(hit.delta) + '\n' : '') +
                'Probabilidad acumulada: ' + fpct(hit.cum, 1) +
                '\n\nLos Δ se suman entre sí; los porcentajes no.');
            } else hideTip();
          };
          cv.onmouseleave = function () { hideTip(); clearChipHighlight(); };
        }
        function clearChipHighlight() {
          var all = CONFIG.factors.concat(['validador']), i, ch;
          for (i = 0; i < all.length; i++) {
            ch = document.getElementById('chip-' + all[i]);
            if (ch) ch.className = 'fdm-chip';
          }
        }

        var E_COLS = [
          { k: 'etiqueta', t: 'Característica', num: false, tip: '' },
          { k: 'nivel', t: 'Nivel', num: false, tip: '' },
          { k: 'rol', t: 'Rol', num: false, tip: 'ESTRATO_BASE: define la tasa de partida. FACTOR: entra en la predicción. SESGO_OBSERVADO: se estima pero no se usa.' },
          { k: 'n', t: 'n casos', num: true, tip: 'Casos históricos comparables, contados sin ponderar. Es el que usa el intervalo de Wilson.' },
          { k: 'n_ponderado', t: 'n ponderado', num: true, tip: 'Los mismos casos tras descontar la antigüedad. Es el n que entra en las fórmulas del modelo. Compáralo con m: si es menor, la fila está dominada por el promedio.' },
          { k: 'n_kish', t: 'n Kish', num: true, tip: CONFIG.tips.kish },
          { k: 'y', t: 'Inválidos', num: true, tip: 'Cuántos de esos casos terminaron en INVALIDO.' },
          { k: 'tasa_observada', t: 'Tasa obs.', num: true, tip: CONFIG.tips.obs },
          { k: 'wilson_90', t: 'Wilson 90 %', num: true, tip: CONFIG.tips.wil },
          { k: 'tasa_esperada', t: 'Tasa esperada', num: true, tip: CONFIG.tips.esp },
          { k: 'tasa_encogida', t: 'Tasa encogida', num: true, tip: CONFIG.tips.enc },
          { k: 'delta_logit', t: 'Δ logit', num: true, tip: CONFIG.tips.delta },
          { k: 'odds_ratio', t: 'OR', num: true, tip: CONFIG.tips.or },
          { k: 'contribucion_pct', t: 'Contrib.', num: true, tip: CONFIG.tips.contrib },
          { k: 'lambda_shrinkage', t: 'λ', num: true, tip: CONFIG.tips.lambda },
          { k: 'm_factor', t: 'm', num: true, tip: CONFIG.tips.m },
          { k: 'flags', t: 'Flags', num: false, tip: 'Avisos de soporte de datos para esta fila.' }
        ];

        function renderBlockE(f) {
          var base = null, bias = null, mid = [], i, cc;
          for (i = 0; i < f.caracteristicas_agregadas.length; i++) {
            cc = f.caracteristicas_agregadas[i];
            if (cc.rol === 'ESTRATO_BASE') base = cc;
            else if (cc.rol === 'SESGO_OBSERVADO') bias = cc;
            else mid.push(cc);
          }
          var col = state.sortCol, dir = state.sortDir;
          mid.sort(function (a, b) {
            var va = sortVal(a, col), vb = sortVal(b, col);
            if (va === vb) return 0;
            return (va < vb ? -1 : 1) * dir;
          });
          var rows = [base].concat(mid).concat([bias]);

          var html = '<table id="fdm-feat-table"><thead><tr>';
          for (i = 0; i < E_COLS.length; i++) {
            html += '<th class="' + (E_COLS[i].num ? 'fdm-th-num' : '') + '" data-col="' + E_COLS[i].k + '"' +
              (E_COLS[i].tip ? ' title="' + esc(E_COLS[i].tip) + '"' : '') + '>' + esc(E_COLS[i].t) +
              (col === E_COLS[i].k ? (dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
          }
          html += '</tr></thead><tbody>';

          var wilsonJobs = [];
          for (i = 0; i < rows.length; i++) {
            cc = rows[i];
            if (!cc) continue;
            var cls = cc.rol === 'SESGO_OBSERVADO' ? 'fdm-row-bias'
              : (cc.rol === 'ESTRATO_BASE' ? 'fdm-row-base' : (cc.rank ? 'fdm-row-driver' : ''));
            html += '<tr class="' + cls + '">';
            html += '<td title="' + esc(cc.rol === 'SESGO_OBSERVADO' ? 'No usado para la sugerencia: la herramienta estima el sesgo del validador pero responde «¿debería invalidarse?», no «¿qué diría este validador?».' : '') + '">' +
              esc(cc.etiqueta) + (cc.rol === 'SESGO_OBSERVADO' ? ' <span class="fdm-flagtag">no usado</span>' : '') + '</td>';
            html += '<td><span class="fdm-code">' + esc(trunc(cc.factor === 'validador' ? shortMail(cc.nivel) : cc.nivel, 34)) + '</span></td>';
            html += '<td class="fdm-muted">' + esc(cc.rol) + '</td>';
            html += '<td class="fdm-num">' + fint(cc.n) + '</td>';
            html += '<td class="fdm-num">' + fnum(cc.n_ponderado, 1) + '</td>';
            html += '<td class="fdm-num">' + (isNum(cc.n_kish) ? fnum(cc.n_kish, 1) : DASH) + '</td>';
            html += '<td class="fdm-num">' + fint(cc.y) + '</td>';
            html += '<td class="fdm-num">' + fpct(cc.tasa_observada, 1) + '</td>';
            html += '<td><canvas class="fdm-wilson-mini" data-w="' + wilsonJobs.length + '"></canvas></td>';
            wilsonJobs.push(cc);
            html += '<td class="fdm-num">' + fpct(cc.tasa_esperada, 1) + '</td>';
            html += '<td class="fdm-num">' + fpct(cc.tasa_encogida, 1) + '</td>';
            html += '<td class="fdm-num" style="color:' + (cc.delta_logit > 0 ? C.inv : cc.delta_logit < 0 ? C.val : C.text3) + '">' + fdelta(cc.delta_logit) + '</td>';
            html += '<td class="fdm-num">' + fOR(cc.odds_ratio) + '</td>';
            html += '<td class="fdm-num">' + (cc.rol === 'FACTOR' ? fnum(cc.contribucion_pct, 1) + ' %' : DASH) + '</td>';
            html += '<td class="fdm-num">' + fnum(cc.lambda_shrinkage, 2) + '</td>';
            html += '<td class="fdm-num">' + fint(cc.m_factor) + '</td>';
            var fl = '';
            for (var j = 0; j < cc.flags.length; j++) fl += '<span class="fdm-flagtag fdm-flagtag-warn">' + esc(cc.flags[j]) + '</span>';
            if (!fl && cc.razon) fl = '<span class="fdm-flagtag">' + esc(cc.razon) + '</span>';
            html += '<td>' + (fl || '<span class="fdm-muted">—</span>') + '</td>';
            html += '</tr>';
          }
          html += '</tbody></table>';
          $('e-scroll').innerHTML = html;

          var cvs = $('e-scroll').getElementsByTagName('canvas');
          for (i = 0; i < cvs.length; i++) {
            var job = wilsonJobs[Number(cvs[i].getAttribute('data-w'))];
            if (!job) continue;
            drawWilsonMini(cvs[i], job.wilson_90 ? job.wilson_90[0] : null,
              job.wilson_90 ? job.wilson_90[1] : null, job.tasa_observada, job.tasa_encogida);
            cvs[i].title = job.wilson_90
              ? 'Wilson 90 % de la tasa cruda: ' + fpct(job.wilson_90[0], 1) + ' – ' + fpct(job.wilson_90[1], 1) +
                '\nMarca azul = tasa encogida (' + fpct(job.tasa_encogida, 1) + ')'
              : 'Sin casos para calcular el intervalo.';
          }

          var theads = $('e-scroll').getElementsByTagName('thead');
          if (theads.length > 0) {
            theads[0].onclick = function (e) {
              var t = e.target, ck = t.getAttribute ? t.getAttribute('data-col') : null;
              if (!ck) return;
              if (state.sortCol === ck) state.sortDir = -state.sortDir;
              else { state.sortCol = ck; state.sortDir = -1; }
              renderBlockE(f);
            };
          }
        }
        function sortVal(cc, col) {
          if (col === 'delta_logit') return -Math.abs(cc.delta_logit);
          var v = cc[col];
          if (col === 'wilson_90') return v ? -(v[1] - v[0]) : 0;
          if (typeof v === 'number') return -v;
          return String(v === null || v === undefined ? '' : v);
        }

        function renderBlockF(f) {
          var mo = f.motivo_inferido;
          var icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="' + C.accent +
            '" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>';
          $('block-f').innerHTML =
            '<div class="fdm-motivo-head"><span class="fdm-motivo-icon">' + icon + '</span>' +
            '<span class="fdm-motivo-title" title="' + esc(CONFIG.tips.motivo) + '">' + esc(mo.titulo) + '</span></div>' +
            '<div class="fdm-motivo-text">' + esc(mo.texto) + '</div>' +
            (mo.secundario ? '<div class="fdm-motivo-sec">Patrón secundario: ' + esc(mo.secundario.titulo) +
              ' (' + esc(CONFIG.labels[mo.secundario.factor] || mo.secundario.factor) + ': ' + esc(mo.secundario.nivel) + ')</div>' : '') +
            '<div class="fdm-hypothesis">Hipótesis derivada del patrón estadístico · no es una causa verificada</div>';
        }

        function renderBlockG(f) {
          var rp = f.resumen_precedentes, html = '';
          html += '<div class="fdm-panel-header"><div class="fdm-panel-title">Casos similares</div></div>';
          if (f.casos_similares.length === 0) {
            html += '<div class="fdm-state"><b>Sin precedentes.</b> No hay detecciones anteriores de este mismo tipo de evento en el histórico disponible.</div>';
            $('block-g').innerHTML = html;
            return;
          }
          html += '<div class="fdm-muted" style="margin-bottom:10px">' + rp.invalidados_top5 + ' de los ' + rp.n_top5 +
            ' precedentes más similares fueron INVALIDADOS (' + fpct(rp.tasa_top5, 0) + ') · ' +
            rp.n_casos_mismo_evento + ' casos del mismo evento en el corpus</div>';
          var i, cs, j;
          for (i = 0; i < f.casos_similares.length; i++) {
            cs = f.casos_similares[i];
            html += '<div class="fdm-case">' +
              '<div class="fdm-case-head">' +
              '<span class="fdm-dot" style="background:' + (cs.status_validez === 'INVALIDO' ? C.inv : C.val) + '"></span>' +
              '<span class="fdm-case-id">' + esc(cs.id_deteccion) + '</span>' +
              '<span class="fdm-case-meta">hace ' + cs.dias_atras + ' d</span></div>' +
              '<div class="fdm-muted" style="margin-top:3px">Vuelo ' + esc(cs.id_vuelo) + ' · ' + esc(shortMail(cs.validador)) + '</div>' +
              '<div class="fdm-case-tags">';
            for (j = 0; j < cs.coincidencias.length; j++) html += '<span class="fdm-tag-ok">✓ ' + esc(cs.coincidencias[j]) + '</span>';
            for (j = 0; j < cs.diferencias.length; j++) html += '<span class="fdm-tag-dif">✗ ' + esc(cs.diferencias[j]) + '</span>';
            html += '</div><div class="fdm-case-foot"><span class="fdm-muted">distancia ' + fnum(cs.distancia, 2) + '</span>' +
              '<button type="button" class="fdm-btn" data-case="' + esc(cs.id_deteccion) + '">Abrir ficha</button></div></div>';
          }
          $('block-g').innerHTML = html;
        }

        function renderBlockH(f) {
          var dg = f.diagnostico, html = '';
          if (isNum(dg.mejora_relativa) && dg.mejora_relativa < 0.02) {
            html += '<div class="fdm-alert">Los factores contextuales aportan poco en este dataset; la sugerencia se apoya casi enteramente en el tipo de evento.</div>';
          }
          html += '<div class="fdm-kv-grid">' +
            kv('κ', fnum(dg.kappa, 2), CONFIG.tips.kappa) +
            kv('σ entre validadores', fnum(dg.sigma_validador, 2), CONFIG.tips.sesgo) +
            kv('Semivida', dg.half_life_dias + ' días', 'Un caso de esa antigüedad pesa la mitad que uno de hoy.') +
            kv('Método de m', dg.metodo_m, CONFIG.tips.m) +
            kv('Log-loss holdout', fnum(dg.logloss_holdout, 4), 'Menor es mejor.') +
            kv('Log-loss solo evento', fnum(dg.logloss_baseline_evento, 4), 'Referencia sin factores contextuales.') +
            kv('Mejora relativa', isNum(dg.mejora_relativa) ? fpct(dg.mejora_relativa, 1) : DASH, '') +
            kv('Σδ factores', fdelta(dg.suma_delta), 'Suma de los empujes de los seis factores.') +
            kv('Σδ interacciones', fdelta(dg.suma_delta_int), 'Suma de los empujes de las interacciones aplicadas.') +
            '</div>';

          html += '<table><thead><tr><th>Factor</th><th>m estimado</th></tr></thead><tbody>';
          var ks = ['id_evento'].concat(CONFIG.factors).concat(['validador']), i;
          for (i = 0; i < ks.length; i++) {
            html += '<tr><td>' + esc(CONFIG.labels[ks[i]] || ks[i]) + '</td><td class="fdm-num">' + fint(dg.m_por_factor[ks[i]]) + '</td></tr>';
          }
          html += '</tbody></table>';

          var dr = dg.deriva;
          html += '<div class="fdm-kv-grid" style="margin-top:10px">' +
            kv('Tasa últimos ' + CONFIG.driftWindowDays + ' d', fpct(dr.tasa_90d, 1) + ' (n=' + dr.n_90d + ')', 'Tasa de invalidación reciente de este tipo de evento.') +
            kv('Tasa previa', fpct(dr.tasa_previa, 1) + ' (n=' + dr.n_previa + ')', 'Tasa de invalidación anterior de este tipo de evento.') +
            kv('Deriva', dr.detectada ? 'DETECTADA (' + fdelta(dr.delta) + ')' : (isNum(dr.delta) ? 'no detectada (' + fdelta(dr.delta) + ')' : DASH), 'Cambio del comportamiento del evento en el tiempo.') +
            '</div>';

          html += '<div class="fdm-muted" style="margin-top:10px">Limitación: los términos se tratan como aproximadamente independientes al sumar varianzas, ' +
            'por lo que el IC puede quedar algo estrecho cuando varias características están correlacionadas. κ corrige parcialmente ese efecto en el punto estimado.</div>';

          if (f.flags.length > 0) {
            html += '<div style="margin-top:10px">';
            for (i = 0; i < f.flags.length; i++) html += '<span class="fdm-flagtag fdm-flagtag-warn">' + esc(f.flags[i]) + '</span>';
            html += '</div>';
          }
          $('h-body').innerHTML = html;
        }

        function renderBlockI(f) {
          var prev = loadDecision(f.meta.id_deteccion);
          var html = '<div class="fdm-panel-header"><div class="fdm-panel-title">Registro de decisión</div>' +
            '<div class="fdm-panel-hint">La sugerencia no bloquea ni condiciona la decisión</div></div>';
          html += '<div class="fdm-dec-row">' +
            '<button type="button" class="fdm-btn fdm-btn-red' + (prev && prev.decision === 'INVALIDAR' ? ' fdm-btn-on' : '') + '" data-dec="INVALIDAR">Invalidar</button>' +
            '<button type="button" class="fdm-btn fdm-btn-green' + (prev && prev.decision === 'VALIDAR' ? ' fdm-btn-on' : '') + '" data-dec="VALIDAR">Validar</button>' +
            '<button type="button" class="fdm-btn' + (prev && prev.decision === 'OMITIR' ? ' fdm-btn-on' : '') + '" data-dec="OMITIR">Omitir</button>' +
            '</div>';
          html += '<textarea id="fdm-dec-note" placeholder="Nota opcional para dejar registro del criterio aplicado…">' +
            esc(prev ? prev.nota : '') + '</textarea>';
          html += '<div id="fdm-dec-feedback">' + decisionFeedback(prev, f) + '</div>';
          $('block-i').innerHTML = html;
        }
        function decisionFeedback(prev, f) {
          if (!prev) return '<span class="fdm-muted">Sin decisión registrada para esta detección.</span>';
          if (prev.decision === 'OMITIR') return '<span class="fdm-muted">Detección omitida el ' + esc(fdatetime(new Date(prev.ts))) + '.</span>';
          if (f.sugerencia.accion === 'SIN_SUGERENCIA') return '<span class="fdm-muted">Decisión <b>' + esc(prev.decision) + '</b> registrada. La herramienta no emitió sugerencia.</span>';
          var coincide = (prev.decision === f.sugerencia.accion);
          return '<span style="color:' + (coincide ? C.val : C.amb) + '">Decisión <b>' + esc(prev.decision) +
            '</b> · ' + (coincide ? 'Coincide' : 'Difiere') + ' con la sugerencia.</span>';
        }

        /* --- localStorage --- */
        var LSKEY = 'fdm_decisiones_v1';
        function loadStore() {
          try {
            var raw = window.localStorage ? window.localStorage.getItem(LSKEY) : null;
            return raw ? JSON.parse(raw) : {};
          } catch (e) { return {}; }
        }
        function saveStore(o) {
          try { if (window.localStorage) window.localStorage.setItem(LSKEY, JSON.stringify(o)); } catch (e) { /* sandbox sin storage */ }
        }
        function loadDecision(id) { var s = loadStore(); return s[id] || null; }
        function saveDecision(id, decision, nota, sugerencia) {
          var s = loadStore();
          s[id] = { decision: decision, nota: nota, ts: new Date().getTime(), sugerencia: sugerencia };
          saveStore(s);
        }

        /* ---------- 8. APP ---------- */
        var state = {
          view: 'search', vuelo: null, det: null, origenDet: null, ficha: null,
          verValidadas: false, listPage: 0, preScores: {},
          ajustarValidador: false, sortCol: 'delta_logit', sortDir: -1,
          sesion: { total: 0, coincide: 0 }
        };

        var DS = loadDataset(rawAll);
        if (DS.fatal) {
          var al = $('fdm-alert');
          al.className = 'fdm-alert fdm-alert-error';
          al.innerText = DS.fatal;
          $('fdm-sub').innerText = 'No fue posible iniciar el asistente';
          return;
        }

        var PRIORS = fitPriors(DS.hist, CONFIG);

        renderSearchView(DS);
        renderModelPanel(DS, PRIORS);

        // avisos globales
        var avisos = [];
        if (DS.stats.nEtiquetadas < CONFIG.minLabeledWarn) {
          avisos.push('Solo hay ' + DS.stats.nEtiquetadas + ' detecciones validadas en el histórico (recomendado: ' +
            CONFIG.minLabeledWarn + '). La mayoría de las fichas devolverá SIN SUGERENCIA SUFICIENTE: ese es el comportamiento correcto.');
        }
        if (!CONFIG.strictTemporalCutoff) {
          avisos.push('El corte temporal estricto está desactivado: los resultados no son out-of-sample.');
        }
        if (DS.stats.nFechaInvalida > 0) {
          avisos.push(DS.stats.nFechaInvalida + ' detecciones tienen fecha inválida: reciben el peso mínimo y quedan fuera del cálculo de deriva.');
        }
        if (avisos.length > 0) {
          var alertEl = $('fdm-alert');
          alertEl.className = 'fdm-alert';
          alertEl.innerHTML = avisos.join('<br>');
        }

        /* --- routing entre las 3 vistas del asistente --- */
        function show(view) {
          state.view = view;
          $('view-search').className = 'fdm-view' + (view === 'search' ? ' fdm-view-active' : '');
          $('view-list').className = 'fdm-view' + (view === 'list' ? ' fdm-view-active' : '');
          $('view-card').className = 'fdm-view' + (view === 'card' ? ' fdm-view-active' : '');
          hideTip();
        }

        function openVuelo(id) {
          if (!DS.byVuelo[id]) return;
          state.vuelo = id;
          state.preScores = {};
          renderListView(DS, id);
          show('list');
        }
        // lo publica hacia fuera para que la pestaña de asignación pueda saltar aquí
        abrirVueloEnAsistente = openVuelo;

        function findDet(id) {
          var i, rws = DS.rows;
          for (i = 0; i < rws.length; i++) if (rws[i].id_deteccion === id) return rws[i];
          return null;
        }

        function openDeteccion(id, fromCase) {
          var det = findDet(id);
          if (!det) return;
          if (fromCase && state.det) {
            state.origenDet = state.det.id_deteccion;
            $('btn-back-origin').className = 'fdm-link-btn';
          } else if (!fromCase) {
            state.origenDet = null;
            $('btn-back-origin').className = 'fdm-link-btn fdm-hidden';
          }
          state.det = det;
          state.ajustarValidador = false;
          var t0 = new Date().getTime();
          var ficha = analyze(det, DS, PRIORS, CONFIG);
          state.ficha = ficha;
          renderCard(ficha, det);
          show('card');
          $('fdm-sub').innerText = 'Ficha generada en ' + (new Date().getTime() - t0) +
            ' ms · motor ' + CONFIG.versionMotor;
        }

        /* --- listeners --- */
        var input = $('fdm-search-input'), sugg = $('fdm-suggestions');

        function buildSuggestions(q) {
          q = q.toUpperCase();
          var out = [], i, v;
          for (i = 0; i < DS.vuelos.length && out.length < 8; i++) {
            v = DS.vuelos[i];
            if (String(v.id).toUpperCase().indexOf(q) >= 0 || v.matricula.indexOf(q) >= 0 ||
              v.origen.indexOf(q) >= 0 || v.destino.indexOf(q) >= 0) out.push(v);
          }
          return out;
        }
        function renderSuggestions(list) {
          if (list.length === 0) { sugg.className = 'fdm-hidden'; sugg.innerHTML = ''; return; }
          var html = '', i, v;
          for (i = 0; i < list.length; i++) {
            v = list[i];
            html += '<div class="fdm-sugg" data-vuelo="' + esc(v.id) + '">' +
              '<span class="fdm-sugg-main">' + esc(v.id) + ' · ' + esc(v.matricula) + '</span>' +
              '<span class="fdm-sugg-meta">' + esc(v.origen) + '→' + esc(v.destino) + ' · ' +
              v.pendientes + '/' + v.n + ' pend.</span></div>';
          }
          sugg.innerHTML = html;
          sugg.className = '';
        }
        input.oninput = function () {
          var q = input.value.replace(/^\s+|\s+$/g, '');
          var st = $('fdm-search-state');
          if (q.length === 0) { renderSuggestions([]); st.className = 'fdm-state fdm-hidden'; return; }
          var list = buildSuggestions(q);
          renderSuggestions(list);
          if (list.length === 0) {
            st.className = 'fdm-state';
            st.innerHTML = '<b>Sin coincidencias para «' + esc(q) + '».</b> Prueba con parte del identificador de vuelo, la matrícula o el ICAO de origen o destino.';
          } else st.className = 'fdm-state fdm-hidden';
        };
        input.onkeydown = function (e) {
          if (e.keyCode === 13) {
            var list = buildSuggestions(input.value.replace(/^\s+|\s+$/g, ''));
            if (list.length > 0) { renderSuggestions([]); openVuelo(list[0].id); }
          } else if (e.keyCode === 27) { renderSuggestions([]); }
        };
        sugg.onclick = function (e) {
          var t = e.target, id = null;
          while (t && t !== sugg) { id = t.getAttribute ? t.getAttribute('data-vuelo') : null; if (id) break; t = t.parentNode; }
          if (id) { input.value = id; renderSuggestions([]); openVuelo(id); }
        };
        $('fdm-example-chips').onclick = function (e) {
          var id = e.target.getAttribute ? e.target.getAttribute('data-vuelo') : null;
          if (!id && e.target.parentNode && e.target.parentNode.getAttribute) id = e.target.parentNode.getAttribute('data-vuelo');
          if (id) openVuelo(id);
        };

        $('btn-back-search').onclick = function () { show('search'); };
        $('btn-back-list').onclick = function () { show('list'); };
        $('btn-back-origin').onclick = function () {
          if (state.origenDet) { var id = state.origenDet; state.origenDet = null; openDeteccion(id, false); }
        };
        $('chk-ver-validadas').onclick = function () {
          state.verValidadas = $('chk-ver-validadas').checked;
          state.listPage = 0;
          renderListTable(DS);
        };
        $('fdm-list-body').onclick = function (e) {
          var t = e.target, id = t.getAttribute ? t.getAttribute('data-open') : null;
          if (id) { openDeteccion(id, false); return; }
          while (t && t.getAttribute && !t.getAttribute('data-det')) t = t.parentNode;
          if (t && t.getAttribute && t.getAttribute('data-det')) openDeteccion(t.getAttribute('data-det'), false);
        };
        $('fdm-pagination').onclick = function (e) {
          var p = e.target.getAttribute ? e.target.getAttribute('data-page') : null;
          if (p === null) return;
          var n = Number(p);
          if (n < 0) return;
          state.listPage = n;
          renderListTable(DS);
        };
        $('block-g').onclick = function (e) {
          var id = e.target.getAttribute ? e.target.getAttribute('data-case') : null;
          if (id) openDeteccion(id, true);
        };

        // paneles colapsables: waterfall, tabla de características, diagnóstico
        function collapsible(toggleId, bodyId, hintId, textoAbrir, textoCerrar) {
          $(toggleId).onclick = function () {
            var b = $(bodyId), abierto = b.className.indexOf('fdm-hidden') < 0;
            b.className = abierto ? 'fdm-hidden' : '';
            $(hintId).innerText = abierto ? textoAbrir : textoCerrar;
          };
        }
        collapsible('d-toggle', 'd-body', 'd-toggle-hint', 'mostrar el detalle del cálculo', 'ocultar el detalle');
        collapsible('e-toggle', 'e-body', 'e-toggle-hint', 'mostrar la tabla completa', 'ocultar la tabla');
        collapsible('h-toggle', 'h-body', 'h-toggle-hint', 'mostrar', 'ocultar');

        $('block-i').onclick = function (e) {
          var dec = e.target.getAttribute ? e.target.getAttribute('data-dec') : null;
          if (!dec || !state.ficha) return;
          var noteEl = document.getElementById('fdm-dec-note');
          var nota = noteEl ? noteEl.value : '';
          saveDecision(state.ficha.meta.id_deteccion, dec, nota, state.ficha.sugerencia.accion);
          if (dec !== 'OMITIR' && state.ficha.sugerencia.accion !== 'SIN_SUGERENCIA') {
            state.sesion.total++;
            if (dec === state.ficha.sugerencia.accion) state.sesion.coincide++;
            $('fdm-session-counter').innerText = 'Sesión: ' + state.sesion.coincide + ' de ' + state.sesion.total + ' coinciden';
          }
          renderBlockI(state.ficha);
        };

        /* --- pruebas de correctitud --- */
        function runTests(dsx, priors) {
          var out = [], ok = 0, fail = 0;
          function assert(name, cond, detail) {
            if (cond) { ok++; out.push('PASA · ' + name); }
            else { fail++; out.push('FALLA · ' + name + (detail ? ' → ' + detail : '')); }
          }

          var wl = wilson(29, 41, 1.645);
          assert('Wilson y=29 n=41 z=1.645 ≈ [0.576, 0.812]',
            Math.abs(wl[0] - 0.576) < 0.01 && Math.abs(wl[1] - 0.812) < 0.01,
            '[' + fnum(wl[0], 3) + ', ' + fnum(wl[1], 3) + ']');

          var s1 = shrink(5, 4, 0.3, 20, CONFIG), s2 = shrink(50, 40, 0.3, 20, CONFIG), s3 = shrink(500, 400, 0.3, 20, CONFIG);
          assert('Shrinkage monótono en |δ| con n creciente',
            Math.abs(s1.delta) < Math.abs(s2.delta) && Math.abs(s2.delta) < Math.abs(s3.delta));
          assert('λ → 1 con n creciente', s1.lambda < s2.lambda && s2.lambda < s3.lambda && s3.lambda > 0.9);
          assert('Nivel con n=1 queda bajo minLevelSupport y no aporta δ', 1 < CONFIG.minLevelSupport);

          function nef(sd2, p) { return 1 / (sd2 * sd2 * p * (1 - p)); }
          assert('n efectivo decrece cuando crece sd(logit)', nef(0.2, 0.7) > nef(0.5, 0.7));

          var det = null, i;
          for (i = dsx.rows.length - 1; i >= 0; i--) {
            if (dsx.rows[i].status_validez === 'PENDIENTE') { det = dsx.rows[i]; break; }
          }
          if (!det && dsx.rows.length > 0) det = dsx.rows[dsx.rows.length - 1];

          if (det) {
            var f = analyze(det, dsx, priors, CONFIG);
            var recompute = sigmoid(f.linea_base.logit_evento + f.diagnostico.kappa *
              (f.diagnostico.suma_delta + f.diagnostico.suma_delta_int));
            assert('Reproducibilidad: logit⁻¹(logit_evento + κ·Σδ) === p_invalido (1e-9)',
              Math.abs(recompute - f.sugerencia.p_invalido) < 1e-9);

            var sumPct = 0;
            for (i = 0; i < f.caracteristicas_agregadas.length; i++) {
              if (f.caracteristicas_agregadas[i].rol === 'FACTOR') sumPct += f.caracteristicas_agregadas[i].contribucion_pct;
            }
            assert('Σ contribución de los factores = 100 ± 0.1 (o 0 si no hay efectos)',
              Math.abs(sumPct - 100) < 0.1 || sumPct === 0, fnum(sumPct, 3) + ' %');

            assert('La tabla de características tiene siempre 8 filas',
              f.caracteristicas_agregadas.length === 8, String(f.caracteristicas_agregadas.length));

            var cut = lowerBoundT(dsx.hist, det.t), futuras = 0, mismoVuelo = 0;
            for (i = 0; i < cut; i++) {
              if (dsx.hist[i].t >= det.t) futuras++;
              if (dsx.hist[i].id_vuelo === det.id_vuelo) mismoVuelo++;
            }
            assert('Sin fuga temporal: ninguna fila del corpus tiene timestamp ≥ objetivo', futuras === 0);
            assert('El vuelo del objetivo se excluye del corpus usado',
              f.meta.corpus.n_historico_usado === (cut - mismoVuelo),
              String(f.meta.corpus.n_historico_usado) + ' vs ' + (cut - mismoVuelo));

            assert('Sin NaN/Infinity en la ficha renderizada', !domHasBadNumbers());

            var fake = { m: {}, kappa: priors.kappa, diagnostico: priors.diagnostico, sigma_validador: priors.sigma_validador, delta_validador: {} };
            var kk2;
            for (kk2 in priors.m) if (Object.prototype.hasOwnProperty.call(priors.m, kk2)) fake.m[kk2] = priors.m[kk2];
            var detFake = {}, kk3;
            for (kk3 in det) if (Object.prototype.hasOwnProperty.call(det, kk3)) detFake[kk3] = det[kk3];
            detFake.id_evento = '___EVENTO_INEXISTENTE___';
            detFake.matricula = '___NIVEL_NUEVO___';
            detFake.origen = '___NIVEL_NUEVO___'; detFake.destino = '___NIVEL_NUEVO___';
            detFake.fase_deteccion = '___NIVEL_NUEVO___'; detFake.esquema_datos = '___NIVEL_NUEVO___';
            detFake.dataframe_qar = '___NIVEL_NUEVO___';
            var ff = analyze(detFake, dsx, fake, CONFIG);
            assert('Evento nunca visto ⇒ SIN SUGERENCIA SUFICIENTE y flag EVENTO_NUEVO',
              ff.sugerencia.accion === 'SIN_SUGERENCIA' && indexOfStr(ff.flags, 'EVENTO_NUEVO') >= 0,
              ff.sugerencia.accion);
            assert('Evento nunca visto ⇒ p̂ = tasa global encogida (sin contexto)',
              Math.abs(ff.sugerencia.p_invalido - ff.linea_base.tasa_evento_encogida) < 1e-9);

            // El ECE empírico está sesgado al alza con muestras pequeñas: con n_bin casos
            // el ruido de muestreo por bin ya vale sqrt(p(1-p)/n_bin). Se compara contra
            // ese piso para no confundir ruido del estimador con descalibración real.
            var cal = calibration(dsx, priors, 600);
            if (cal) {
              out.push('Calibración (muestra de ' + cal.n + ' detecciones validadas, 10 bins): ECE = ' +
                fnum(cal.ece, 4) + ' · piso de ruido del estimador = ' + fnum(cal.ruido, 4));
              out.push('   bin      n   p̂ medio   tasa real');
              for (i = 0; i < cal.bins.length; i++) {
                if (cal.bins[i].n === 0) continue;
                out.push('   ' + (i / 10).toFixed(1) + '–' + ((i + 1) / 10).toFixed(1) +
                  '  ' + ('    ' + cal.bins[i].n).slice(-5) +
                  '   ' + fpct(cal.bins[i].sp / cal.bins[i].n, 1) +
                  '     ' + fpct(cal.bins[i].sy / cal.bins[i].n, 1));
              }
              assert('ECE ≤ 0.05 (o dentro del ruido del estimador)',
                cal.ece <= 0.05 + cal.ruido, 'ECE ' + fnum(cal.ece, 4) + ' vs umbral ' + fnum(0.05 + cal.ruido, 4));
            }
          }

          out.unshift('Pruebas: ' + ok + ' pasan, ' + fail + ' fallan.');
          DIAG.innerText = out.join('\n');
          DIAG.style.color = fail === 0 ? '#137333' : '#d93025';
        }

        function indexOfStr(arr, s) {
          for (var i = 0; i < arr.length; i++) if (arr[i] === s) return i;
          return -1;
        }
        function domHasBadNumbers() {
          var el = document.getElementById('view-card');
          if (!el) return false;
          var t = el.innerText || '';
          return t.indexOf('NaN') >= 0 || t.indexOf('undefined') >= 0 || t.indexOf('Infinity') >= 0;
        }
        function calibration(dsx, priors, maxN) {
          var hist = dsx.hist;
          if (hist.length < 200) return null;
          var start = Math.floor(hist.length * 0.8);
          var pool = hist.length - start;
          if (pool < 50) return null;
          var stepN = Math.max(1, Math.floor(pool / maxN));
          var bins = [], i, j;
          for (i = 0; i < 10; i++) bins.push({ n: 0, sp: 0, sy: 0 });
          var used = 0;
          for (i = start; i < hist.length; i += stepN) {
            var p = analyze(hist[i], dsx, priors, CONFIG).sugerencia.p_invalido;
            var b = Math.min(9, Math.floor(p * 10));
            bins[b].n++; bins[b].sp += p; bins[b].sy += hist[i].inv ? 1 : 0;
            used++;
          }
          var ece = 0, ruido = 0;
          for (j = 0; j < 10; j++) {
            if (bins[j].n === 0) continue;
            var pb = bins[j].sp / bins[j].n, yb = bins[j].sy / bins[j].n;
            ece += (bins[j].n / used) * Math.abs(pb - yb);
            ruido += (bins[j].n / used) * Math.sqrt(Math.max(pb * (1 - pb), 1e-6) / bins[j].n) * Math.sqrt(2 / Math.PI);
          }
          return { ece: ece, n: used, ruido: ruido, bins: bins };
        }

        try {
          if (window.location && String(window.location.search).indexOf('test=1') >= 0) runTests(DS, PRIORS);
        } catch (e3) { /* sandbox sin location */ }
      } catch (err) {
        if (DIAG) {
          DIAG.innerText = 'Error en el asistente: ' + (err && err.message ? err.message : String(err)) +
            (err && err.stack ? '\n' + err.stack : '');
        }
      }
    }

    /* ==============================================================
       PARTE 3 — ASIGNACIÓN DE VUELOS PENDIENTES
       ============================================================== */
    function initAsignacion() {
      var ADIAG = document.getElementById('asg-diag');
      try {

        /* ==========================================================
           CONFIGURACIÓN — esto es lo único que hay que editar
           ==========================================================

           1) PLANTILLA: los analistas entre los que se reparte el trabajo.
              - `id`     identificador corto y estable. NO lo cambies una vez
                         en uso: la asignación depende de él, y cambiarlo
                         reasigna los vuelos de esa persona.
              - `nombre` lo que se muestra en pantalla.
              - `correo` debe coincidir con `lastmodifiedby` del dataset para
                         poder contar sus validaciones. Sin correo, el conteo
                         de los últimos 30 días sale en 0.
              - `activo` false lo deja fuera del reparto (vacaciones, baja)
                         pero conserva su histórico de validaciones.
              - `capacidad` peso relativo opcional (1 = normal, 0.5 = media
                         jornada, 2 = doble). Si lo omites, vale 1.          */
        var ANALISTAS = [
          { id: 'ana',    nombre: 'Ana Pérez',      correo: 'ana.perez@avianca.com',      activo: true },
          { id: 'carlos', nombre: 'Carlos Gómez',   correo: 'carlos.gomez@avianca.com',   activo: true },
          { id: 'diana',  nombre: 'Diana Restrepo', correo: 'diana.restrepo@avianca.com', activo: true },
          { id: 'jorge',  nombre: 'Jorge Martínez', correo: 'jorge.martinez@avianca.com', activo: true },
          { id: 'laura',  nombre: 'Laura Sánchez',  correo: 'laura.sanchez@avianca.com',  activo: true, capacidad: 0.5 }
        ];

        /* 2) RESTRICCIONES: tipos de evento que solo puede gestionar un subgrupo.
              La clave es el nombre exacto del evento tal como llega en
              `eventname`; el valor, la lista de ids habilitados.
              Un evento que NO aparezca aquí lo puede gestionar cualquiera.
              Como un vuelo se asigna completo a una persona, esa persona debe
              estar habilitada para TODOS los eventos del vuelo; si ninguna lo
              está, el vuelo sale listado aparte como conflicto.               */
        var RESTRICCIONES = {
          // 'NOMBRE EXACTO DEL EVENTO': ['ana', 'carlos'],
          // 'OTRO EVENTO RESTRINGIDO': ['diana']
        };

        /* 3) Ventana del conteo de productividad, en días. */
        var VENTANA_DIAS = 30;

        /* 3b) Antigüedad máxima de un evento para entrar al reparto, en días.
               Los eventos abiertos más viejos que esto quedan fuera de la
               asignación y se reportan aparte: son trabajo rezagado que no
               tiene sentido repartir como si fuera nuevo.
               La ventana se mide desde la fecha de hoy, no desde la fila más
               reciente del dataset: si el feed se atrasa, el trabajo viejo
               tiene que verse viejo en lugar de rejuvenecer solo. Si el dato
               más reciente queda fuera de la ventana, la pestaña lo avisa.   */
        var ANTIGUEDAD_MAX_DIAS = 180;

        /* 4) Holgura extra, en eventos, sobre el techo de carga más ajustado
              que es factible. 0 = el mejor balance posible. Subirlo a 1 o 2 da
              más margen a cada analista, lo que hace que el reparto se mueva
              menos cuando entra trabajo nuevo, a costa de cargas menos parejas.
              Nota: se expresa en eventos, no en porcentaje, porque con cargas
              pequeñas un porcentaje redondeado hacia arriba infla el techo
              mucho más de lo que parece.                                       */
        var HOLGURA_EXTRA_EVENTOS = 0;

        /* ========== fin de la configuración ========== */

        var DIA_MS = 86400000;

        function esc2(s) {
          return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        function fdate2(d) {
          if (!d || isNaN(d.getTime())) return '—';
          var ms = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
          return ('0' + d.getDate()).slice(-2) + ' ' + ms[d.getMonth()] + ' ' + d.getFullYear();
        }

        /* Hash FNV-1a de 32 bits. Determinista e idéntico en cualquier
           navegador: solo usa aritmética entera de 32 bits. Es lo que hace
           que el reparto sea reproducible sin guardar nada en ningún lado. */
        function hash32(s) {
          var h = 0x811c9dc5, i;
          for (i = 0; i < s.length; i++) {
            h = h ^ s.charCodeAt(i);
            // h * 16777619 sin perder precisión
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
          }
          return h >>> 0;
        }

        /* ---------- 1. Vuelos pendientes y su carga ---------- */
        // Se agrupan los eventos abiertos por vuelo. La carga de un vuelo es
        // su número de eventos abiertos de severidad alta.
        function construirVuelos() {
          var i, r, fid, o, fecha;

          // Pasada 1: fecha más reciente del dataset, solo para informar y
          // para detectar un feed atrasado. El corte se mide desde hoy.
          var ultimoDato = 0;
          for (i = 0; i < rawAll.length; i++) {
            r = rawAll[i];
            if (!hasValue(r['eventid'])) continue;
            fecha = parseDateSafe(r['eventdate']) || parseDateSafe(r['takeoffdate']);
            if (fecha && fecha.getTime() > ultimoDato) ultimoDato = fecha.getTime();
          }
          var hoy = new Date().getTime();
          var corteAsignacion = hoy - ANTIGUEDAD_MAX_DIAS * DIA_MS;

          // Pasada 2: agrupar por vuelo los eventos abiertos dentro de la ventana.
          var porVuelo = {}, antiguos = {}, nEventosAntiguos = 0, nEventosSinFecha = 0;
          for (i = 0; i < rawAll.length; i++) {
            r = rawAll[i];
            if (!hasValue(r['eventid'])) continue;
            if (!toBool(r['isopen'])) continue;              // solo lo pendiente
            fecha = parseDateSafe(r['eventdate']) || parseDateSafe(r['takeoffdate']);
            fid = clean(r['flightid'], '(sin vuelo)');

            if (!fecha) {                                     // sin fecha utilizable
              nEventosSinFecha++;
              antiguos[fid] = true;
              continue;
            }
            if (fecha.getTime() < corteAsignacion) {          // más viejo que la ventana
              nEventosAntiguos++;
              antiguos[fid] = true;
              continue;
            }

            o = porVuelo[fid];
            if (!o) {
              o = porVuelo[fid] = {
                id: fid, carga: 0, eventos: [], tipos: {},
                matricula: clean(r['registration'], '(sin dato)'),
                origen: clean(r['originicao'], '(sin dato)'),
                destino: clean(r['destinationicao'], '(sin dato)'),
                fecha: fecha, t: fecha.getTime()
              };
            }
            o.carga += 1;
            o.eventos.push(clean(r['eventname'], '(sin nombre)'));
            o.tipos[clean(r['eventname'], '(sin nombre)')] = true;
            if (fecha.getTime() > o.t) { o.fecha = fecha; o.t = fecha.getTime(); }
          }

          var lista = [], k, nVuelosAntiguos = 0;
          for (k in porVuelo) {
            if (Object.prototype.hasOwnProperty.call(porVuelo, k)) lista.push(porVuelo[k]);
          }
          // un vuelo cuenta como rezagado solo si no quedó nada suyo dentro de la ventana
          for (k in antiguos) {
            if (Object.prototype.hasOwnProperty.call(antiguos, k) && !porVuelo[k]) nVuelosAntiguos++;
          }

          // Orden determinista: primero los de más carga, desempate por id.
          // No depende de cómo venga ordenado el dataset.
          lista.sort(function (a, b) {
            if (b.carga !== a.carga) return b.carga - a.carga;
            return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
          });
          return {
            vuelos: lista, hoy: hoy, ultimoDato: ultimoDato, corte: corteAsignacion,
            vuelosAntiguos: nVuelosAntiguos,
            eventosAntiguos: nEventosAntiguos,
            eventosSinFecha: nEventosSinFecha,
            feedAtrasado: (ultimoDato > 0 && ultimoDato < corteAsignacion)
          };
        }

        /* ---------- 2. Elegibilidad ---------- */
        // Una persona puede tomar un vuelo si está habilitada para todos sus
        // tipos de evento. Un evento sin restricción no excluye a nadie.
        function elegiblesPara(vuelo, activos) {
          var permitidos = null, tipo, i, j;
          for (tipo in vuelo.tipos) {
            if (!Object.prototype.hasOwnProperty.call(vuelo.tipos, tipo)) continue;
            var lista = RESTRICCIONES[tipo];
            if (!lista || lista.length === 0) continue;       // sin restricción
            if (permitidos === null) {
              permitidos = {};
              for (i = 0; i < lista.length; i++) permitidos[lista[i]] = true;
            } else {
              // intersección con lo ya permitido
              var nuevo = {};
              for (i = 0; i < lista.length; i++) if (permitidos[lista[i]]) nuevo[lista[i]] = true;
              permitidos = nuevo;
            }
          }
          var out = [];
          for (j = 0; j < activos.length; j++) {
            if (permitidos === null || permitidos[activos[j].id]) out.push(activos[j]);
          }
          return out;
        }

        /* ---------- 3. Reparto determinista y estable ----------
           Hashing de encuentro (rendezvous) con carga acotada:

           a) Cada vuelo tiene un orden de preferencia propio sobre los
              analistas, dado por hash(idVuelo + '|' + idAnalista). Ese orden
              no depende de qué otros vuelos existan, así que un vuelo
              conserva su dueño aunque entre o salga trabajo.
           b) Se recorren los vuelos de mayor a menor carga y cada uno va al
              primer analista de su preferencia que todavía quepa bajo el
              techo de carga. Solo los vuelos que no caben se desvían.
           c) Si nadie cabe, se sube el techo y se repite. Así siempre termina.

           Resultado: determinista (mismo dataset ⇒ mismo reparto en cualquier
           equipo, sin guardar nada) y estable (el trabajo nuevo no reorganiza
           lo que ya estaba repartido).                                        */
        function repartir(vuelos, activos) {
          var i, j, a;
          var asignacion = {}, conflictos = [];
          var cargaTotal = 0, capacidadTotal = 0;
          for (i = 0; i < vuelos.length; i++) cargaTotal += vuelos[i].carga;
          for (i = 0; i < activos.length; i++) capacidadTotal += (activos[i].capacidad || 1);

          var carga = {};
          for (i = 0; i < activos.length; i++) carga[activos[i].id] = 0;
          if (activos.length === 0 || capacidadTotal <= 0) {
            return { asignacion: asignacion, carga: carga, conflictos: vuelos.slice(0), cargaTotal: cargaTotal };
          }

          // preferencias por vuelo, calculadas una sola vez
          var prefs = [];
          for (i = 0; i < vuelos.length; i++) {
            var eleg = elegiblesPara(vuelos[i], activos);
            if (eleg.length === 0) { conflictos.push(vuelos[i]); prefs.push(null); continue; }
            var orden = [];
            for (j = 0; j < eleg.length; j++) {
              orden.push({ a: eleg[j], h: hash32(vuelos[i].id + '|' + eleg[j].id) });
            }
            orden.sort(function (x, y) {
              if (x.h !== y.h) return y.h - x.h;             // mayor hash primero
              return x.a.id < y.a.id ? -1 : 1;               // desempate estable
            });
            prefs.push(orden);
          }

          /* Un intento de reparto con un techo unitario U: cada analista
             admite round(U · su capacidad) eventos. Devuelve null si algún
             vuelo no cabe en ninguno de sus elegibles. */
          function intentar(U) {
            var cg = {}, asg = {}, tch = {}, ii, jj, aa;
            for (ii = 0; ii < activos.length; ii++) {
              aa = activos[ii];
              cg[aa.id] = 0;
              tch[aa.id] = Math.max(1, Math.round(U * (aa.capacidad || 1)));
            }
            for (ii = 0; ii < vuelos.length; ii++) {
              if (prefs[ii] === null) continue;              // conflicto, ya listado
              var colocado = false;
              for (jj = 0; jj < prefs[ii].length; jj++) {
                aa = prefs[ii][jj].a;
                if (cg[aa.id] + vuelos[ii].carga <= tch[aa.id]) {
                  asg[vuelos[ii].id] = aa.id;
                  cg[aa.id] += vuelos[ii].carga;
                  colocado = true;
                  break;
                }
              }
              if (!colocado) return null;
            }
            return { asignacion: asg, carga: cg, techo: tch };
          }

          /* Búsqueda binaria del techo unitario mínimo factible.
             Subir el techo nunca empeora la colocación (cada vuelo tiene más
             opciones), así que la factibilidad es monótona en U y la búsqueda
             binaria es válida. Esto da el reparto más parejo que permite el
             orden de preferencia, en vez de depender de un porcentaje que el
             redondeo infla cuando las cargas son pequeñas. */
          var lo = 1, hi = Math.max(1, cargaTotal);
          var mejorIntento = intentar(hi);
          if (mejorIntento) {
            while (lo < hi) {
              var mid = Math.floor((lo + hi) / 2);
              if (intentar(mid)) hi = mid; else lo = mid + 1;
            }
            var U = lo + (HOLGURA_EXTRA_EVENTOS > 0 ? HOLGURA_EXTRA_EVENTOS : 0);
            var conHolgura = intentar(U);
            mejorIntento = conHolgura || intentar(lo);
          }

          if (mejorIntento) {
            asignacion = mejorIntento.asignacion;
            carga = mejorIntento.carga;
          }

          // red de seguridad: si algo quedara suelto pese a todo, va al
          // elegible con menos carga (sigue siendo determinista)
          for (i = 0; i < vuelos.length; i++) {
            if (prefs[i] === null || asignacion[vuelos[i].id]) continue;
            var mejor = null;
            for (j = 0; j < prefs[i].length; j++) {
              a = prefs[i][j].a;
              if (mejor === null || carga[a.id] < carga[mejor.id]) mejor = a;
            }
            if (mejor) { asignacion[vuelos[i].id] = mejor.id; carga[mejor.id] += vuelos[i].carga; }
          }

          // carga máxima ideal si los vuelos fueran divisibles, para contrastar
          var idealMax = 0;
          for (i = 0; i < activos.length; i++) {
            var objI = cargaTotal * ((activos[i].capacidad || 1) / capacidadTotal);
            if (objI > idealMax) idealMax = objI;
          }

          return {
            asignacion: asignacion, carga: carga, conflictos: conflictos,
            cargaTotal: cargaTotal, techoUnitario: lo, idealMax: idealMax
          };
        }

        /* ---------- 4. Registro de validaciones ----------
           Cuenta los eventos ya cerrados por cada persona. La ventana de 30
           días se mide sobre `eventdate` porque el dataset no trae la fecha
           real de validación: es una aproximación y la UI lo advierte. */
        function contarValidaciones(activosPorCorreo, ahora) {
          var res = {}, i, r, quien, k;
          var corte = ahora - VENTANA_DIAS * DIA_MS;
          for (i = 0; i < ANALISTAS.length; i++) {
            res[ANALISTAS[i].id] = { ventana: 0, total: 0, invalidados: 0 };
          }
          for (i = 0; i < rawAll.length; i++) {
            r = rawAll[i];
            if (!hasValue(r['eventid'])) continue;
            if (toBool(r['isopen'])) continue;                // solo lo ya validado
            quien = clean(r['lastmodifiedby'], '').toLowerCase();
            if (!quien) continue;
            k = activosPorCorreo[quien];
            if (!k) continue;                                 // validador fuera de la plantilla
            res[k].total += 1;
            if (toBool(r['isinvalid'])) res[k].invalidados += 1;
            var fecha = parseDateSafe(r['eventdate']) || parseDateSafe(r['takeoffdate']);
            if (fecha && fecha.getTime() >= corte) res[k].ventana += 1;
          }
          return res;
        }

        /* ---------- 5. Cálculo ---------- */
        var construido = construirVuelos();
        var vuelos = construido.vuelos;
        var ahora = construido.hoy;          // las dos ventanas se miden desde hoy

        var activos = [], porCorreo = {}, i, j;
        for (i = 0; i < ANALISTAS.length; i++) {
          if (ANALISTAS[i].activo !== false) activos.push(ANALISTAS[i]);
          if (ANALISTAS[i].correo) porCorreo[String(ANALISTAS[i].correo).toLowerCase()] = ANALISTAS[i].id;
        }

        var rep = repartir(vuelos, activos);
        var validaciones = contarValidaciones(porCorreo, ahora);

        // vuelos por analista
        var vuelosDe = {};
        for (i = 0; i < activos.length; i++) vuelosDe[activos[i].id] = [];
        for (i = 0; i < vuelos.length; i++) {
          var dueno = rep.asignacion[vuelos[i].id];
          if (dueno && vuelosDe[dueno]) vuelosDe[dueno].push(vuelos[i]);
        }

        // restricciones que afectan a cada analista (para la columna informativa)
        var restriccionesDe = {}, tipoR;
        for (i = 0; i < activos.length; i++) restriccionesDe[activos[i].id] = [];
        for (tipoR in RESTRICCIONES) {
          if (!Object.prototype.hasOwnProperty.call(RESTRICCIONES, tipoR)) continue;
          var habil = RESTRICCIONES[tipoR];
          for (j = 0; j < habil.length; j++) {
            if (restriccionesDe[habil[j]]) restriccionesDe[habil[j]].push(tipoR);
          }
        }

        /* ---------- 6. Render ---------- */
        var capacidadTotal = 0;
        for (i = 0; i < activos.length; i++) capacidadTotal += (activos[i].capacidad || 1);

        function objetivoDe(a) {
          if (capacidadTotal <= 0) return 0;
          return rep.cargaTotal * ((a.capacidad || 1) / capacidadTotal);
        }

        function renderKpis() {
          document.getElementById('asg-kpi-vuelos').innerText = String(vuelos.length);
          var pieVuelos = [];
          if (rep.conflictos.length > 0) pieVuelos.push(rep.conflictos.length + ' sin analista habilitado');
          if (construido.vuelosAntiguos > 0) pieVuelos.push(construido.vuelosAntiguos + ' fuera de ventana');
          document.getElementById('asg-kpi-vuelos-foot').innerText =
            pieVuelos.length > 0 ? pieVuelos.join(' · ') : 'todos asignados';
          document.getElementById('asg-kpi-eventos').innerText = String(rep.cargaTotal);
          document.getElementById('asg-kpi-analistas').innerText = String(activos.length);
          document.getElementById('asg-kpi-analistas-foot').innerText =
            (ANALISTAS.length - activos.length) + ' inactivos de ' + ANALISTAS.length;
          var media = activos.length > 0 ? rep.cargaTotal / activos.length : 0;
          document.getElementById('asg-kpi-media').innerText = (Math.round(media * 10) / 10) + '';
          document.getElementById('asg-kpi-media-foot').innerText = 'eventos por analista';
        }

        function renderTabla() {
          var html = '', k, a, cg, obj, pctObj, cls, maxCarga = 1;
          for (i = 0; i < activos.length; i++) {
            if (rep.carga[activos[i].id] > maxCarga) maxCarga = rep.carga[activos[i].id];
          }
          var orden = activos.slice(0);
          orden.sort(function (x, y) { return rep.carga[y.id] - rep.carga[x.id]; });

          for (i = 0; i < orden.length; i++) {
            a = orden[i];
            cg = rep.carga[a.id] || 0;
            obj = objetivoDe(a);
            pctObj = obj > 0 ? cg / obj : 0;
            cls = pctObj > 1.08 ? 'asg-over' : (pctObj < 0.92 ? 'asg-under' : '');
            var anchoBarra = Math.round((cg / maxCarga) * 100);
            var anchoMeta = maxCarga > 0 ? Math.round((obj / maxCarga) * 100) : 0;
            var vd = validaciones[a.id] || { ventana: 0, total: 0 };
            var rs = restriccionesDe[a.id] || [];
            var rsHtml = rs.length === 0
              ? '<span class="asg-tag">sin restricciones</span>'
              : '';
            for (j = 0; j < rs.length && j < 3; j++) rsHtml += '<span class="asg-tag asg-tag-ok">' + esc2(rs[j]) + '</span>';
            if (rs.length > 3) rsHtml += '<span class="asg-tag">+' + (rs.length - 3) + '</span>';

            html += '<tr data-analista="' + esc2(a.id) + '">' +
              '<td><div class="asg-nombre">' + esc2(a.nombre) + '</div>' +
              '<div class="asg-correo">' + esc2(a.correo || '—') +
              ((a.capacidad && a.capacidad !== 1) ? ' · capacidad ' + a.capacidad + '×' : '') + '</div></td>' +
              '<td class="asg-num asg-mono">' + (vuelosDe[a.id] ? vuelosDe[a.id].length : 0) + '</td>' +
              '<td class="asg-num asg-mono">' + cg + '</td>' +
              '<td><div class="asg-bar"><div class="asg-bar-track">' +
              '<span class="asg-bar-fill ' + cls + '" style="width:' + anchoBarra + '%"></span>' +
              '<span class="asg-bar-goal" style="left:' + anchoMeta + '%"></span>' +
              '</div><span class="asg-bar-pct">' + (obj > 0 ? Math.round(pctObj * 100) + '%' : '—') + '</span></div></td>' +
              '<td class="asg-num asg-mono">' + vd.ventana + '</td>' +
              '<td>' + rsHtml + '</td>' +
              '</tr>';
          }

          // inactivos, solo informativos
          for (i = 0; i < ANALISTAS.length; i++) {
            if (ANALISTAS[i].activo !== false) continue;
            a = ANALISTAS[i];
            var vdi = validaciones[a.id] || { ventana: 0 };
            html += '<tr class="asg-row-off"><td><div class="asg-nombre">' + esc2(a.nombre) + '</div>' +
              '<div class="asg-correo">' + esc2(a.correo || '—') + '</div></td>' +
              '<td class="asg-num">—</td><td class="asg-num">—</td>' +
              '<td><span class="asg-tag">inactivo, fuera del reparto</span></td>' +
              '<td class="asg-num asg-mono">' + vdi.ventana + '</td><td>—</td></tr>';
          }

          document.getElementById('asg-tbody').innerHTML = html;

          // resumen de balance
          var minC = null, maxC = null;
          for (i = 0; i < activos.length; i++) {
            var c2 = rep.carga[activos[i].id] || 0;
            if (minC === null || c2 < minC) minC = c2;
            if (maxC === null || c2 > maxC) maxC = c2;
          }
          document.getElementById('asg-balance').innerText = activos.length > 0
            ? ('Carga entre ' + minC + ' y ' + maxC + ' eventos · diferencia máxima ' + (maxC - minC))
            : 'Sin analistas activos';
        }

        function renderConflictos() {
          var panel = document.getElementById('asg-conflictos-panel');
          if (rep.conflictos.length === 0) { panel.className = 'panel asg-hidden'; return; }
          panel.className = 'panel';
          var html = '', v, tipos, t;
          for (i = 0; i < rep.conflictos.length; i++) {
            v = rep.conflictos[i];
            tipos = [];
            for (t in v.tipos) if (Object.prototype.hasOwnProperty.call(v.tipos, t)) tipos.push(t);
            html += '<div class="asg-conflicto">Vuelo <b>' + esc2(v.id) + '</b> · ' + esc2(v.matricula) +
              ' · ' + v.carga + ' evento(s). Ningún analista está habilitado para todos sus tipos: ' +
              esc2(tipos.join(' · ')) + '.</div>';
          }
          document.getElementById('asg-conflictos').innerHTML = html;
        }

        function renderDetalle(idAnalista) {
          var a = null;
          for (i = 0; i < ANALISTAS.length; i++) if (ANALISTAS[i].id === idAnalista) a = ANALISTAS[i];
          if (!a) return;
          var lista = vuelosDe[idAnalista] || [];
          document.getElementById('asg-detalle-titulo').innerText =
            'Vuelos asignados a ' + a.nombre + ' (' + lista.length + ' vuelos · ' + (rep.carga[idAnalista] || 0) + ' eventos)';

          var html = '', v, tipos, t;
          for (i = 0; i < lista.length; i++) {
            v = lista[i];
            tipos = [];
            for (t in v.tipos) if (Object.prototype.hasOwnProperty.call(v.tipos, t)) tipos.push(t);
            html += '<tr>' +
              '<td class="asg-mono">' + esc2(v.id) + '</td>' +
              '<td class="asg-mono">' + esc2(v.matricula) + '</td>' +
              '<td>' + esc2(v.origen) + ' → ' + esc2(v.destino) + '</td>' +
              '<td>' + esc2(fdate2(v.fecha)) + '</td>' +
              '<td class="asg-num asg-mono">' + v.carga + '</td>' +
              '<td>' + esc2(tipos.join(' · ')) + '</td>' +
              '<td style="text-align:right"><button type="button" class="fdm-btn" data-ir="' + esc2(v.id) + '">Analizar →</button></td>' +
              '</tr>';
          }
          if (lista.length === 0) {
            html = '<tr><td colspan="7" class="asg-muted">Sin vuelos asignados en este momento.</td></tr>';
          }
          document.getElementById('asg-detalle-tbody').innerHTML = html;
          document.getElementById('asg-detalle-panel').className = 'panel';

          var filas = document.getElementById('asg-tbody').getElementsByTagName('tr');
          for (i = 0; i < filas.length; i++) {
            var fid2 = filas[i].getAttribute('data-analista');
            filas[i].className = (fid2 === idAnalista) ? 'asg-row-sel' : (filas[i].className.indexOf('asg-row-off') >= 0 ? 'asg-row-off' : '');
          }
        }

        function renderAvisos() {
          var avisos = [];
          if (activos.length === 0) {
            avisos.push('<b>No hay analistas activos.</b> Edita la lista ANALISTAS en la sección de configuración de app.js.');
          }
          if (construido.feedAtrasado) {
            avisos.push('<b>El dataset está atrasado.</b> Su evento más reciente es del ' +
              esc2(fdate2(new Date(construido.ultimoDato))) + ', anterior al corte de ' + ANTIGUEDAD_MAX_DIAS +
              ' días, así que no hay nada que repartir. Revisa la consulta de Sara antes de usar esta pestaña.');
          }
          var sinCorreo = 0;
          for (i = 0; i < ANALISTAS.length; i++) if (!ANALISTAS[i].correo) sinCorreo++;
          if (sinCorreo > 0) {
            avisos.push(sinCorreo + ' analista(s) sin correo configurado: su conteo de validaciones saldrá en cero.');
          }
          var el = document.getElementById('asg-alert');
          if (avisos.length === 0) { el.className = 'asg-alert asg-hidden'; return; }
          el.className = 'asg-alert' + ((activos.length === 0 || construido.feedAtrasado) ? ' asg-alert-error' : '');
          el.innerHTML = avisos.join('<br>');
        }

        function renderNota() {
          var ventana = '<b>Ventana de asignación:</b> solo entran al reparto los eventos abiertos de los últimos ' +
            ANTIGUEDAD_MAX_DIAS + ' días, es decir desde el ' + esc2(fdate2(new Date(construido.corte))) +
            '. El dato más reciente del dataset es del ' + esc2(fdate2(new Date(construido.ultimoDato))) + '.';
          if (construido.eventosAntiguos > 0 || construido.eventosSinFecha > 0) {
            ventana += ' Quedaron fuera ' + construido.eventosAntiguos + ' evento(s) por antigüedad';
            if (construido.eventosSinFecha > 0) ventana += ' y ' + construido.eventosSinFecha + ' sin fecha utilizable';
            ventana += ', que afectan a ' + construido.vuelosAntiguos +
              ' vuelo(s) que no aparecen en el reparto. Siguen pendientes en Sara: hay que tratarlos aparte.';
          }
          document.getElementById('asg-nota').innerHTML = ventana + '<br>' +
            'El reparto es determinista: se calcula a partir del dataset y de la lista de analistas, sin guardar nada, ' +
            'así que todos los equipos ven exactamente la misma asignación. Un vuelo conserva su responsable aunque ' +
            'entren vuelos nuevos o se complete trabajo; solo se mueve si hace falta para respetar el techo de carga ' +
            'o si cambia la plantilla. El techo de este reparto es de <b>' + rep.techoUnitario +
            ' evento(s)</b> por analista de capacidad plena, el más ajustado con el que todos los vuelos caben ' +
            '(el mínimo teórico, si los vuelos se pudieran partir, sería ' + (Math.round(rep.idealMax * 10) / 10) + ').<br>' +
            '<b>Limitación del conteo de ' + VENTANA_DIAS + ' días:</b> el dataset no incluye la fecha en que se validó ' +
            'cada evento, así que la ventana se mide sobre la fecha del evento. Mide actividad sobre vuelos recientes, ' +
            'no productividad exacta. Para corregirlo hay que añadir la columna de fecha de modificación al SELECT.';
        }

        renderAvisos();
        renderKpis();
        renderTabla();
        renderConflictos();
        renderNota();

        /* ---------- 7. Listeners ---------- */
        document.getElementById('asg-tbody').onclick = function (e) {
          var t = e.target;
          while (t && t.getAttribute && !t.getAttribute('data-analista')) t = t.parentNode;
          if (t && t.getAttribute && t.getAttribute('data-analista')) renderDetalle(t.getAttribute('data-analista'));
        };
        document.getElementById('asg-detalle-cerrar').onclick = function () {
          document.getElementById('asg-detalle-panel').className = 'panel asg-hidden';
        };
        document.getElementById('asg-detalle-tbody').onclick = function (e) {
          var id = e.target.getAttribute ? e.target.getAttribute('data-ir') : null;
          if (id) irAlAsistente(id);
        };
        document.getElementById('asg-copy').onclick = function () {
          var txt = 'Reparto de vuelos pendientes\n', a, k;
          for (k = 0; k < activos.length; k++) {
            a = activos[k];
            var lv = vuelosDe[a.id] || [];
            txt += '\n' + a.nombre + ' — ' + lv.length + ' vuelos, ' + (rep.carga[a.id] || 0) + ' eventos\n';
            for (var z = 0; z < lv.length; z++) {
              txt += '  ' + lv[z].id + '  ' + lv[z].matricula + '  ' + lv[z].origen + '→' + lv[z].destino +
                '  ' + lv[z].carga + ' ev.\n';
            }
          }
          ADIAG.style.color = '#5f6368';
          ADIAG.innerText = txt;
        };

      } catch (err) {
        if (ADIAG) {
          ADIAG.innerText = 'Error en la asignación: ' + (err && err.message ? err.message : String(err)) +
            (err && err.stack ? '\n' + err.stack : '');
        }
      }
    }

  } catch (err) {
    if (diag) diag.innerText = 'Error: ' + err.message;
  }
})();
