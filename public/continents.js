(() => {
  window.addEventListener("DOMContentLoaded", async () => {
    const CY_EL = document.getElementById("cy");
    if (!CY_EL) return;

    if (typeof cytoscapeFcose !== "undefined") {
      cytoscape.use(cytoscapeFcose);
    } else {
      console.warn("cytoscape-fcose not loaded; falling back to cose");
    }

    function normalize(s) {
      return (s ?? "")
        .toString()
        .trim()
        .replace(/^\uFEFF/, "");
    }

    function parseCsv(text) {
      const res = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        delimiter: ";", // your dataset uses semicolons
      });

      if (res.errors?.length) console.warn("CSV parse warnings:", res.errors);

      return (res.data || []).filter((r) =>
        Object.keys(r).some((k) => (r[k] ?? "").toString().trim() !== "")
      );
    }

    // Layer 4: nodes=continent, edges=shared papers
    function buildElements(rows) {
      // paper_id -> Set(continent)
      const paperContinents = new Map();

      // continent -> node id
      const contToId = new Map();
      let counter = 0;

      const getContId = (cont) => {
        if (!contToId.has(cont)) contToId.set(cont, `cont_${++counter}`);
        return contToId.get(cont);
      };

      for (const r of rows) {
        const paper_id = normalize(r.paper_id);
        const continent = (r.continent ?? "").toString().trim();

        if (!paper_id || !continent) continue;

        if (!paperContinents.has(paper_id))
          paperContinents.set(paper_id, new Set());
        paperContinents.get(paper_id).add(continent);
      }

      // Aggregate edges by pair
      const edgeWeight = new Map();
      const connected = new Set();

      for (const set of paperContinents.values()) {
        const list = Array.from(set).sort();
        if (list.length < 2) continue;

        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];

            const idA = getContId(a);
            const idB = getContId(b);

            const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
            edgeWeight.set(key, (edgeWeight.get(key) || 0) + 1);

            connected.add(idA);
            connected.add(idB);
          }
        }
      }

      const nodes = [];
      for (const [cont, id] of contToId.entries()) {
        if (!connected.has(id)) continue;
        nodes.push({ data: { id, label: cont } });
      }

      const edges = [];
      for (const [key, w] of edgeWeight.entries()) {
        const [source, target] = key.split("|");
        edges.push({ data: { id: key, source, target, weight: w } });
      }

      return [...nodes, ...edges];
    }

    function render(elements) {
      const layoutConfig =
        typeof cytoscapeFcose !== "undefined"
          ? {
              name: "fcose",
              quality: "default",
              animate: true,
              nodeSeparation: 260,
              nodeRepulsion: 16000,
              idealEdgeLength: 300,
              gravity: 0.25,
              numIter: 2000,
              padding: 70,
              randomize: true,
            }
          : {
              name: "cose",
              animate: true,
              nodeRepulsion: 22000,
              idealEdgeLength: 320,
              nodeOverlap: 100,
              componentSpacing: 220,
              padding: 70,
              numIter: 3500,
            };

      const cy = cytoscape({
        container: CY_EL,
        elements,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "font-size": 14,
              "text-valign": "center",
              "text-halign": "center",
              "text-wrap": "wrap",
              "text-max-width": 10,
              "background-color": "#5a6ae6",
              color: "white",
              "line-height": 0.95,
              "text-outline-width": 0.7,
              "text-outline-color": "#5a6ae6",
              width: 46,
              height: 46,
            },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              "line-color": "#999",
              "line-opacity": 0.6,
              width: "mapData(weight, 1, 10, 1, 9)",
            },
          },
          {
            selector: "edge.edgeHL",
            style: {
              "line-color": "#00e5ff", // neon core
              "line-opacity": 1,

              // // --- NEON GLOW ---
              // "underlay-color": "#00e5ff",
              // "underlay-opacity": 0.6,
              // "underlay-padding": 6,
              // width: "mapData(weight, 1, 10, 3, 12)",
              width: "mapData(weight, 1, 10, 3, 13)",

              // smooth look
              "transition-property":
                "underlay-opacity underlay-padding line-color",
              "transition-duration": "0.15s",
            },
          },
        ],
        layout: layoutConfig,
      });

      const updateEdgeHighlight = () => {
        cy.edges().removeClass("edgeHL");
        cy.nodes(":selected").connectedEdges().addClass("edgeHL");
      };

      cy.on("select unselect", "node", updateEdgeHighlight);
    }

    try {
      const resp = await fetch("./mockup_data.csv", { cache: "no-store" });
      if (!resp.ok) throw new Error(`Failed to fetch CSV: HTTP ${resp.status}`);
      const text = await resp.text();

      const rows = parseCsv(text);
      const elements = buildElements(rows);

      if (!elements.length) {
        throw new Error(
          "No continent nodes/edges created. Check 'continent' and 'paper_id' columns."
        );
      }

      render(elements);
    } catch (err) {
      console.error(err);
      CY_EL.innerHTML = `<div style="padding:16px; color:#b45309;">${err.message}</div>`;
    }
  });
})();
