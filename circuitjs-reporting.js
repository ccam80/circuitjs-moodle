/**
 * CircuitJS1 Reporting Script for STACK Integration
 *
 * Add this script to circuitjs.html (before </body>) in the
 * circuitjs-moodle fork. It enables postMessage-based data reporting
 * so the simulator works inside STACK's sandboxed [[iframe]] block
 * (which forbids contentWindow access to nested iframes).
 *
 * Protocol:
 *   Parent sends:  { type: 'circuitjs-subscribe', nodes, elements, rate, permissions }
 *   permissions: { editableIndices, removableIndices, typeRules }
 *   This script sends back:
 *     { type: 'circuitjs-data', values: { ... } }         — periodic update
 *     { type: 'circuitjs-elements', elements: [ ... ] }   — on circuit change
 *
 * Usage in circuitjs.html:
 *   <script src="circuitjs-reporting.js"></script>
 *   (or inline the contents before </body>)
 */
(function(exports) {
  'use strict';

  // Meta-only prefixes: these lines are not elements and are excluded.
  // 'w' (wire) is NOT excluded here — wires are real API elements and must
  // be kept to maintain 1:1 alignment with sim.getElements().
  var META_ONLY_PREFIXES = ['$', 'o', '38', 'h', '&'];

  /**
   * Build per-element info from export text + API elements.
   * Returns array of { typeCode, coords, paramSig, apiType } or null on mismatch.
   */
  function buildElementInfo(exportText, elems) {
    var lines = exportText.split('\n').filter(function(line) {
      line = line.trim();
      if (!line) return false;
      for (var p = 0; p < META_ONLY_PREFIXES.length; p++) {
        var pfx = META_ONLY_PREFIXES[p];
        if (line === pfx || line.indexOf(pfx + ' ') === 0) return false;
      }
      return true;
    });
    if (lines.length !== elems.length) return null;
    var info = [];
    for (var i = 0; i < lines.length; i++) {
      var fields = lines[i].split(' ');
      var typeCode = fields[0];
      var postCount;
      try { postCount = elems[i].getPostCount(); } catch(e) { postCount = 2; }
      // coords = pairs of (x,y) for each post — stable positional identity
      var coords = '';
      for (var c = 1; c < 1 + 2 * postCount && c < fields.length; c++) {
        coords += (c > 1 ? ' ' : '') + fields[c];
      }
      var firstParamIndex = 2 * postCount + 2;
      var paramSig = fields.slice(firstParamIndex).join(' ');
      var apiType;
      try { apiType = elems[i].getType(); } catch(e) { apiType = ''; }
      info.push({
        typeCode: typeCode,
        coords: coords,
        paramSig: paramSig,
        apiType: apiType
      });
    }
    return info;
  }

  /**
   * Check integrity: compare current circuit against baseline.
   *
   * 1. Non-editable, non-removable baseline elements must exist at same
   *    coords with same paramSig.
   * 2. Removable elements may disappear.
   * 3. Type-level limits: additions must not exceed maxAdd, removals beyond
   *    per-component removable must not exceed maxRemove.
   * 4. Element types with no type rule must not increase in count.
   *
   * @param {Array} currentInfo - array of {typeCode, coords, paramSig, apiType}
   * @param {Object} baseline - { info, typeCounts, editableIndices, removableIndices, typeRules }
   * @returns {number} 1 = OK, 0 = integrity failed
   */
  function checkIntegrity(currentInfo, baseline) {
    if (!baseline || !baseline.info) return 1;

    var baselineInfo = baseline.info;
    var baselineTypeCounts = baseline.typeCounts;
    var editableIndices = baseline.editableIndices;
    var removableIndices = baseline.removableIndices;
    var typeRules = baseline.typeRules;

    // Build lookup of current elements by typeCode+coords
    var currentByKey = {};
    for (var ci = 0; ci < currentInfo.length; ci++) {
      var key = currentInfo[ci].typeCode + '|' + currentInfo[ci].coords;
      currentByKey[key] = currentInfo[ci];
    }

    // Check each baseline element
    for (var bi = 0; bi < baselineInfo.length; bi++) {
      if (editableIndices.has(bi)) continue;  // free to change
      if (removableIndices.has(bi)) continue;  // free to disappear

      var bElem = baselineInfo[bi];
      var bKey = bElem.typeCode + '|' + bElem.coords;
      var match = currentByKey[bKey];
      if (!match) return 0;  // element was deleted
      if (match.paramSig !== bElem.paramSig) return 0;  // params changed
    }

    // Count current elements by apiType
    var currentTypeCounts = {};
    for (var ti = 0; ti < currentInfo.length; ti++) {
      var t = currentInfo[ti].apiType;
      currentTypeCounts[t] = (currentTypeCounts[t] || 0) + 1;
    }

    // Count removable elements per type (these are allowed to disappear)
    var removableTypeCounts = {};
    for (var ri = 0; ri < baselineInfo.length; ri++) {
      if (removableIndices.has(ri)) {
        var rt = baselineInfo[ri].apiType;
        removableTypeCounts[rt] = (removableTypeCounts[rt] || 0) + 1;
      }
    }

    // Check type-level constraints
    for (var apiType in baselineTypeCounts) {
      var baseCount = baselineTypeCounts[apiType] || 0;
      var curCount = currentTypeCounts[apiType] || 0;
      var rule = typeRules[apiType];
      var removableOfType = removableTypeCounts[apiType] || 0;

      if (rule) {
        // Additions check
        var added = curCount - baseCount;
        if (added > 0 && added > rule.maxAdd) return 0;
        // Removals check (beyond per-component removable)
        var removed = baseCount - curCount;
        if (removed > removableOfType) {
          var excessRemoved = removed - removableOfType;
          if (excessRemoved > rule.maxRemove) return 0;
        }
      } else {
        // No type rule: count must not increase (no unauthorized additions)
        if (curCount > baseCount) return 0;
        // Removals beyond removable not allowed without a type rule
        var removedNoRule = baseCount - curCount;
        if (removedNoRule > removableOfType) return 0;
      }
    }

    // Check for entirely new types not in baseline
    for (var newType in currentTypeCounts) {
      if (!(newType in baselineTypeCounts)) {
        var newRule = typeRules[newType];
        if (!newRule || currentTypeCounts[newType] > newRule.maxAdd) return 0;
      }
    }

    return 1;
  }

  /**
   * Build type counts from element info array.
   * @param {Array} info - array of {typeCode, coords, paramSig, apiType}
   * @returns {Object} mapping apiType → count
   */
  function buildTypeCounts(info) {
    var counts = {};
    for (var i = 0; i < info.length; i++) {
      var t = info[i].apiType;
      counts[t] = (counts[t] || 0) + 1;
    }
    return counts;
  }

  // ── Export pure functions for testing ──
  exports.buildElementInfo = buildElementInfo;
  exports.checkIntegrity = checkIntegrity;
  exports.buildTypeCounts = buildTypeCounts;
  exports.META_ONLY_PREFIXES = META_ONLY_PREFIXES;

  // ── Browser runtime only (skip in Node.js) ──
  if (typeof window === 'undefined') return;

  var subscribed = false;

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.type !== 'circuitjs-subscribe' || subscribed) return;
    subscribed = true;

    var config = event.data;
    var nodes = config.nodes || [];
    var elements = config.elements || [];
    var rate = config.rate || 4;

    // Parse permissions (new format) with fallback to old editableIndices
    var perms = config.permissions || {};
    var editableIndices = new Set((perms.editableIndices || config.editableIndices || []).map(Number));
    var removableIndices = new Set((perms.removableIndices || []).map(Number));
    var typeRules = {};  // apiType -> { maxAdd, maxRemove }
    var typeRulesArr = perms.typeRules || [];
    for (var tr = 0; tr < typeRulesArr.length; tr++) {
      typeRules[typeRulesArr[tr].type] = {
        maxAdd: typeRulesArr[tr].maxAdd || 0,
        maxRemove: typeRulesArr[tr].maxRemove || 0
      };
    }

    // Integrity checking is active when a permissions key is present,
    // even if all arrays are empty (= everything locked).
    // Absence of permissions key means no integrity checking.
    var hasPermissions = !!(config.permissions || config.editableIndices);

    var skipEvery = Math.max(1, Math.round(60 / rate));
    var updateCount = 0;
    var labelMap = {};
    var baselineInfo = null;
    var baselineTypeCounts = null;
    var integrityOk = 1;

    /** Build baseline object for checkIntegrity calls. */
    function makeBaseline() {
      return {
        info: baselineInfo,
        typeCounts: baselineTypeCounts,
        editableIndices: editableIndices,
        removableIndices: removableIndices,
        typeRules: typeRules
      };
    }

    function connect() {
      if (!window.CircuitJS1) {
        window.oncircuitjsloaded = connect;
        setTimeout(connect, 300);
        return;
      }
      var sim = window.CircuitJS1;

      sim.onupdate = function() {
        try {
          updateCount++;
          if (updateCount % skipEvery !== 0) return;
          var data = { type: 'circuitjs-data', values: {} };

          for (var i = 0; i < nodes.length; i++) {
            try { data.values[nodes[i]] = sim.getNodeVoltage(nodes[i]); }
            catch(e) { data.values[nodes[i]] = null; }
          }

          if (elements.length > 0) {
            var allElems = sim.getElements();
            for (var j = 0; j < elements.length; j++) {
              var parts = elements[j].split(':');
              var idx = parseInt(parts[0], 10);
              var prop = parts[1] || 'current';
              if (idx < allElems.length) {
                try {
                  if (prop === 'current')
                    data.values[elements[j]] = allElems[idx].getCurrent();
                  else if (prop === 'voltageDiff' || prop === 'voltage')
                    data.values[elements[j]] = allElems[idx].getVoltageDiff();
                  else if (prop === 'power')
                    data.values[elements[j]] = allElems[idx].getVoltageDiff() * allElems[idx].getCurrent();
                } catch(e) { data.values[elements[j]] = null; }
              }
            }
          }

          if (hasPermissions) {
            data.values['integrity'] = integrityOk;
          }

          window.parent.postMessage(data, '*');
        } catch(e) {}
      };

      sim.onanalyze = function() {
        try {
          var elems = sim.getElements();
          var info = [];
          labelMap = {};
          for (var k = 0; k < elems.length; k++) {
            var e = elems[k];
            var lbl = '';
            try { lbl = e.getLabelName() || ''; } catch(x) {}
            info.push({ index: k, type: e.getType(), label: lbl });
            if (lbl) labelMap[lbl] = e;
          }

          var exported = sim.exportCircuit();
          var ctz = null;
          try {
            ctz = window.LZString
              ? LZString.compressToEncodedURIComponent(exported)
              : null;
          } catch(x) {}

          window.parent.postMessage({
            type: 'circuitjs-elements',
            elements: info,
            ctz: ctz
          }, '*');

          if (hasPermissions) {
            var elemInfo = buildElementInfo(exported, elems);
            if (elemInfo) {
              integrityOk = checkIntegrity(elemInfo, makeBaseline());
            }
          }
        } catch(e) {}
      };

      // Immediately capture baseline from the already-analyzed circuit
      // (CircuitJS1 analyzes on load before our subscribe arrives)
      if (hasPermissions) {
        try {
          var elems = sim.getElements();
          var exported = sim.exportCircuit();
          var initialInfo = buildElementInfo(exported, elems);
          if (initialInfo) {
            baselineInfo = initialInfo;
            baselineTypeCounts = buildTypeCounts(initialInfo);
            // Expose baseline for integration testing
            exports._baseline = makeBaseline();
          }
        } catch(e) {}
      }
    }
    connect();
  });
})(typeof module !== 'undefined' && module.exports
    ? module.exports
    : (typeof window !== 'undefined' ? (window.__cjsReporting = {}) : {}));
