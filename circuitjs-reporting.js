/**
 * CircuitJS1 Reporting Script for STACK Integration
 *
 * Add this script to circuitjs.html (before </body>) in the
 * circuitjs-moodle fork. It enables postMessage-based data reporting
 * so the simulator works inside STACK's sandboxed [[iframe]] block
 * (which forbids contentWindow access to nested iframes).
 *
 * Protocol:
 *   Parent sends:  { type: 'circuitjs-subscribe', nodes, elements, rate, editableIndices }
 *   This script sends back:
 *     { type: 'circuitjs-data', values: { ... } }         — periodic update
 *     { type: 'circuitjs-elements', elements: [ ... ] }   — on circuit change
 *
 * Usage in circuitjs.html:
 *   <script src="circuitjs-reporting.js"></script>
 *   (or inline the contents before </body>)
 */
(function() {
  var subscribed = false;

  var NON_ELEMENT_PREFIXES = ['$', 'w', 'o', '38', 'h', '&'];

  function extractSignatures(exportText, elems) {
    var lines = exportText.split('\n').filter(function(line) {
      line = line.trim();
      if (!line) return false;
      for (var p = 0; p < NON_ELEMENT_PREFIXES.length; p++) {
        var pfx = NON_ELEMENT_PREFIXES[p];
        if (line === pfx || line.indexOf(pfx + ' ') === 0) return false;
      }
      return true;
    });
    if (lines.length !== elems.length) return null;
    var sigs = [];
    for (var i = 0; i < lines.length; i++) {
      var fields = lines[i].split(' ');
      var typeCode = fields[0];
      var postCount;
      try { postCount = elems[i].getPostCount(); } catch(e) { postCount = 2; }
      var firstParamIndex = 2 * postCount + 2;
      var paramFields = fields.slice(firstParamIndex);
      sigs.push(typeCode + ' ' + paramFields.join(' '));
    }
    return sigs;
  }

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.type !== 'circuitjs-subscribe' || subscribed) return;
    subscribed = true;

    var config = event.data;
    var nodes = config.nodes || [];
    var elements = config.elements || [];
    var rate = config.rate || 4;
    var editableIndices = new Set((config.editableIndices || []).map(Number));
    var skipEvery = Math.max(1, Math.round(60 / rate));
    var updateCount = 0;
    var labelMap = {};
    var baselineSignatures = null;
    var integrityOk = 1;

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

          if (editableIndices.size > 0) {
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

          if (editableIndices.size > 0) {
            var sigs = extractSignatures(exported, elems);
            if (sigs) {
              if (!baselineSignatures) {
                baselineSignatures = sigs;
              } else {
                integrityOk = 1;
                for (var ci = 0; ci < baselineSignatures.length; ci++) {
                  if (editableIndices.has(ci)) continue;
                  if (ci >= sigs.length || sigs[ci] !== baselineSignatures[ci]) {
                    integrityOk = 0;
                    break;
                  }
                }
                if (sigs.length !== baselineSignatures.length) integrityOk = 0;
              }
            }
          }
        } catch(e) {}
      };
    }
    connect();
  });
})();
