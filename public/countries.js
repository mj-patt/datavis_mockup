(() => {
  window.addEventListener("DOMContentLoaded", async () => {
    const CY_EL = document.getElementById("cy");
    const tooltip = document.getElementById("tooltip");
    if (!CY_EL || !tooltip) return;

    // Register fcose layout
    if (typeof cytoscapeFcose !== "undefined") {
      cytoscape.use(cytoscapeFcose);
    } else {
      console.warn("cytoscape-fcose not loaded; falling back to cose");
    }

    //draggable tooltip
    (() => {
      let dragging = false;
      let offsetX = 0;
      let offsetY = 0;

      tooltip.style.cursor = "move";

      const clamp = (left, top) => {
        const margin = 8;
        const rect = tooltip.getBoundingClientRect();
        const maxLeft = window.innerWidth - rect.width - margin;
        const maxTop = window.innerHeight - rect.height - margin;
        return {
          left: Math.max(margin, Math.min(left, maxLeft)),
          top: Math.max(margin, Math.min(top, maxTop)),
        };
      };

      tooltip.addEventListener("pointerdown", (e) => {
        if (e.button != null && e.button !== 0) return;
        dragging = true;
        tooltip.setPointerCapture(e.pointerId);
        const rect = tooltip.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        e.preventDefault();
      });

      tooltip.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const pos = clamp(e.clientX - offsetX, e.clientY - offsetY);
        tooltip.style.left = `${pos.left}px`;
        tooltip.style.top = `${pos.top}px`;
      });

      tooltip.addEventListener("pointerup", (e) => {
        dragging = false;
        try {
          tooltip.releasePointerCapture(e.pointerId);
        } catch {}
      });

      tooltip.addEventListener("pointercancel", () => {
        dragging = false;
      });
    })();

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
        delimiter: ";",
      });

      if (res.errors?.length) console.warn("CSV parse warnings:", res.errors);

      return (res.data || []).filter((r) =>
        Object.keys(r).some((k) => (r[k] ?? "").toString().trim() !== "")
      );
    }

    function escapeHtml(s) {
      return (s ?? "")
        .toString()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function showTooltipAt(x, y, html) {
      tooltip.innerHTML = html;
      tooltip.style.display = "block";

      const pad = 12;
      let left = x + pad;
      let top = y + pad;

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;

      const rect = tooltip.getBoundingClientRect();

      if (left + rect.width > window.innerWidth - 8)
        left = window.innerWidth - rect.width - 8;
      if (top + rect.height > window.innerHeight - 8)
        top = window.innerHeight - rect.height - 8;

      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${Math.max(8, top)}px`;
    }

    function hideTooltip() {
      tooltip.style.display = "none";
      tooltip.innerHTML = "";
    }

    // Layer 3: nodes=country, edges=shared papers
    // Also build countryInfo for tooltip: country nodeId -> { name, institutions:Set }
    function buildCountryGraph(rows) {
      const paperCountries = new Map(); // paper_id -> Set(country)
      const countryToId = new Map(); // country -> nodeId
      let counter = 0;

      const countryInfo = new Map(); // nodeId -> { id, name, institutions:Set }

      const getCountryId = (country) => {
        if (!countryToId.has(country)) {
          const id = `cty_${++counter}`;
          countryToId.set(country, id);
          countryInfo.set(id, { id, name: country, institutions: new Set() });
        }
        return countryToId.get(country);
      };

      for (const r of rows) {
        const paper_id = normalize(r.paper_id);
        const country = (r.country ?? "").toString().trim();
        const institution = (r.institution ?? "").toString().trim();

        if (!paper_id || !country) continue;

        const cId = getCountryId(country);
        if (institution) countryInfo.get(cId).institutions.add(institution);

        if (!paperCountries.has(paper_id))
          paperCountries.set(paper_id, new Set());
        paperCountries.get(paper_id).add(country);
      }

      // Aggregate edges by pair (A|B)
      const edgeWeight = new Map();
      const connected = new Set();

      for (const set of paperCountries.values()) {
        const list = Array.from(set).sort();
        if (list.length < 2) continue;

        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            const idA = getCountryId(a);
            const idB = getCountryId(b);

            const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
            edgeWeight.set(key, (edgeWeight.get(key) || 0) + 1);

            connected.add(idA);
            connected.add(idB);
          }
        }
      }

      // Nodes
      const nodes = [];
      for (const [country, id] of countryToId.entries()) {
        if (!connected.has(id)) continue;
        const info = countryInfo.get(id);

        nodes.push({
          data: {
            id,
            label: country,
            instCount: info ? info.institutions.size : 0, //  number of institutions
          },
        });
      }

      // Edges
      const edges = [];
      for (const [key, w] of edgeWeight.entries()) {
        const [source, target] = key.split("|");
        edges.push({ data: { id: key, source, target, weight: w } });
      }

      return { elements: [...nodes, ...edges], countryInfo };
    }

    function render(elements, countryInfo) {
      const layoutConfig =
        typeof cytoscapeFcose !== "undefined"
          ? {
              name: "fcose",
              quality: "default",
              animate: true,
              nodeSeparation: 200,
              nodeRepulsion: 14000,
              idealEdgeLength: 240,
              gravity: 0.25,
              numIter: 2500,
              padding: 60,
              randomize: true,
            }
          : {
              name: "cose",
              animate: true,
              nodeRepulsion: 20000,
              idealEdgeLength: 260,
              nodeOverlap: 200,
              componentSpacing: 180,
              padding: 60,
              numIter: 4000,
            };

      const cy = cytoscape({
        container: CY_EL,
        elements,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "font-size": "mapData(instCount, 1, 30, 10, 14)",

              "text-valign": "center",
              "text-halign": "center",
              "text-wrap": "wrap",
              "text-max-width": 10,
              "line-height": 0.95,
              color: "white",
              "text-outline-width": 0.7,
              "text-outline-color": "#f97316",
              "background-color": "#f97316",
              width: "mapData(instCount, 1, 30, 30, 85)",
              height: "mapData(instCount, 1, 30, 30, 85)",
            },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              "line-color": "#999",
              "line-opacity": 0.55,
              width: "mapData(weight, 1, 10, 1, 7)",
            },
          },

          // dim unrelated nodes only
          {
            selector: "node.dim",
            style: {
              opacity: 0.15,
              "text-opacity": 0.15,
            },
          },

          // highlighted node
          {
            selector: "node.nodeHL",
            style: {
              "border-width": 3,
              "border-color": "#00e5ff",
              "underlay-color": "#00e5ff",
              "underlay-opacity": 0.35,
              "underlay-padding": 6,
            },
          },

          // highlighted edges
          {
            selector: "edge.edgeHL",
            style: {
              "line-color": "#00e5ff",
              "line-opacity": 1,
              width: "mapData(weight, 1, 10, 2, 10)",
              "transition-property":
                "line-color line-opacity width underlay-opacity underlay-padding",
              "transition-duration": "0.15s",
            },
          },
        ],
        layout: layoutConfig,
      });

      // clear old highlights first!
      const clearFocus = () => {
        cy.nodes().removeClass("dim nodeHL");
        cy.edges().removeClass("edgeHL");
      };

      const focusOnNode = (node) => {
        // clear previous highlights
        cy.nodes().removeClass("nodeHL");
        cy.edges().removeClass("edgeHL");

        // dim all nodes
        cy.nodes().addClass("dim");

        // undim selected + neighbors
        node.closedNeighborhood().nodes().removeClass("dim");

        // highlight selection
        node.addClass("nodeHL");
        node.connectedEdges().addClass("edgeHL");
      };

      // Tooltip behavior
      cy.on("tap", "node", (evt) => {
        const node = evt.target;
        focusOnNode(node);

        const id = node.id();
        const info = countryInfo.get(id);
        if (!info) return;

        const institutions = Array.from(info.institutions).sort((a, b) =>
          a.localeCompare(b)
        );

        const instItems = institutions
          .slice(0, 25)
          .map((inst) => `<li>${escapeHtml(inst)}</li>`)
          .join("");

        const moreCount = Math.max(0, institutions.length - 25);

        const html = `
          <h3 style="font-family:sans-serif; margin:0 0 6px 0;">
            ${escapeHtml(info.name)}
          </h3>

          <div style="font-family:sans-serif; margin-top:6px;">
            <span class="pill">Institutions: ${institutions.length}</span>
          </div>

          <div style="margin-top:10px; font-family:sans-serif">
            <b>Institutions</b>
            <ul>${instItems || "<li class='muted'>—</li>"}</ul>
            ${
              moreCount
                ? `<div class="muted" style="margin-top:6px;">…and ${moreCount} more</div>`
                : ""
            }
          </div>
        `;

        const oe = evt.originalEvent;
        if (oe && typeof oe.clientX === "number") {
          showTooltipAt(oe.clientX, oe.clientY, html);
        } else {
          const rp = node.renderedPosition();
          const rect = CY_EL.getBoundingClientRect();
          showTooltipAt(rect.left + rp.x, rect.top + rp.y, html);
        }
      });

      // background tap clears everything
      cy.on("tap", (evt) => {
        if (evt.target === cy) {
          hideTooltip();
          clearFocus();
        }
      });

      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          hideTooltip();
          clearFocus();
        }
      });

      // hide tooltip on zoom/pan
      cy.on("zoom pan", () => hideTooltip());
    }

    try {
      const resp = await fetch("./mockup_data.csv", { cache: "no-store" });
      if (!resp.ok) throw new Error(`Failed to fetch CSV: HTTP ${resp.status}`);
      const text = await resp.text();

      const rows = parseCsv(text);
      const { elements, countryInfo } = buildCountryGraph(rows);

      if (!elements.length)
        throw new Error(
          "No country nodes/edges created. Check 'country' and 'paper_id' columns."
        );

      render(elements, countryInfo);
    } catch (err) {
      console.error(err);
      tooltip.style.display = "none";
      CY_EL.innerHTML = `<div style="padding:16px; color:#b45309;">${err.message}</div>`;
    }
  });
})();
