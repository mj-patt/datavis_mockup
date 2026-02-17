(() => {
  window.addEventListener("DOMContentLoaded", async () => {
    const CY_EL = document.getElementById("cy");
    const tooltip = document.getElementById("tooltip");
    if (!CY_EL || !tooltip) return;

    // Register fcose layout. Doesn't work. Adjust later!!!
    if (typeof cytoscapeFcose !== "undefined") {
      cytoscape.use(cytoscapeFcose);
    } else {
      console.warn("cytoscape-fcose not loaded; falling back to cose");
    }

    // tooltip draggable
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
        if (e.button != null && e.button !== 0) return; // primary only
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

      // Position with viewport clamping
      const pad = 12;
      let left = x + pad;
      let top = y + pad;

      // must set once so rect is correct
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

    // Layer 2: nodes=institution, edges=shared papers
    // build instInfo for tooltip: institution -> { name, countries:Set, authors:Map(author_id -> name) }
    function buildInstitutionGraph(rows) {
      const paperInstitutions = new Map(); // paper_id -> Set(institution)
      const instToId = new Map(); // institution -> nodeId
      let instCounter = 0;

      const instInfo = new Map(); // instId -> info (by node id for direct lookup)

      const getInstId = (inst) => {
        if (!instToId.has(inst)) {
          const id = `inst_${++instCounter}`;
          instToId.set(inst, id);
          instInfo.set(id, {
            id,
            name: inst,
            countries: new Set(),
            authors: new Map(), // author_id -> author_name
          });
        }
        return instToId.get(inst);
      };

      for (const r of rows) {
        const paper_id = normalize(r.paper_id);
        const institution = (r.institution ?? "").toString().trim();
        const country = (r.country ?? "").toString().trim();
        const author_id = normalize(r.author_id);
        const author_name = (r.author_name ?? "").toString().trim();

        if (!paper_id || !institution) continue;

        const instId = getInstId(institution);

        // tooltip aggregation
        const info = instInfo.get(instId);
        if (country) info.countries.add(country);
        if (author_id) info.authors.set(author_id, author_name || author_id);

        // edge aggregation basis
        if (!paperInstitutions.has(paper_id))
          paperInstitutions.set(paper_id, new Set());
        paperInstitutions.get(paper_id).add(institution);
      }

      // Aggregate edges by institution pair
      const edgeWeight = new Map(); // "idA|idB" -> count
      const connected = new Set();

      for (const set of paperInstitutions.values()) {
        const instList = Array.from(set).sort();
        if (instList.length < 2) continue;

        for (let i = 0; i < instList.length; i++) {
          for (let j = i + 1; j < instList.length; j++) {
            const a = instList[i];
            const b = instList[j];
            const idA = getInstId(a);
            const idB = getInstId(b);

            const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
            edgeWeight.set(key, (edgeWeight.get(key) || 0) + 1);

            connected.add(idA);
            connected.add(idB);
          }
        }
      }

      // Build nodes
      const nodes = [];
      for (const [inst, id] of instToId.entries()) {
        if (!connected.has(id)) continue;
        const info = instInfo.get(id);

        nodes.push({
          data: {
            id,
            label: inst,
            authorCount: info ? info.authors.size : 0, // ✅ unique authors
          },
        });
      }

      const edges = [];
      for (const [key, w] of edgeWeight.entries()) {
        const [source, target] = key.split("|");
        edges.push({ data: { id: key, source, target, weight: w } });
      }

      return { elements: [...nodes, ...edges], instInfo };
    }

    function render(elements, instInfo) {
      const layoutConfig =
        typeof cytoscapeFcose !== "undefined"
          ? {
              name: "fcose",
              quality: "default",
              animate: true,
              nodeSeparation: 160,
              nodeRepulsion: 12000,
              idealEdgeLength: 200,
              gravity: 0.25,
              numIter: 2500,
              padding: 60,
              randomize: true,
            }
          : {
              name: "cose",
              animate: true,
              nodeRepulsion: 16000,
              idealEdgeLength: 220,
              nodeOverlap: 200,
              componentSpacing: 10,
              padding: 60,
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
              "font-size": "mapData(authorCount, 1, 50, 9, 13)",

              "text-valign": "center",
              "text-halign": "center",
              "text-wrap": "wrap",
              "text-max-width": 10,
              "background-color": "#c24e67",
              "text-outline-width": 0.8,
              "text-outline-color": "#c24e67",
              color: "white",
              "line-height": 0.95,
              width: "mapData(authorCount, 1, 50, 35, 90)",
              height: "mapData(authorCount, 1, 50, 35, 90)",
            },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              "line-color": "#999",
              "line-opacity": 0.6,
              width: "mapData(weight, 1, 10, 1, 7)",
            },
          },

          // dim unrelated nodes (do NOT dim edges)
          {
            selector: "node.dim",
            style: {
              opacity: 0.15,
              "text-opacity": 0.15,
            },
          },

          // highlighted node (border + glow)
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

          // neon highlighted edges
          {
            selector: "edge.edgeHL",
            style: {
              "line-color": "#00e5ff",
              "line-opacity": 1,
              width: "mapData(weight, 1, 10, 3, 11)",
              "transition-property":
                "line-color line-opacity width underlay-opacity underlay-padding",
              "transition-duration": "0.15s",
            },
          },
        ],
        layout: layoutConfig,
      });

      const clearFocus = () => {
        cy.nodes().removeClass("dim nodeHL");
        cy.edges().removeClass("edgeHL");
      };

      const focusOnNode = (node) => {
        // clear previous selection highlight
        cy.nodes().removeClass("nodeHL");
        cy.edges().removeClass("edgeHL");

        // dim all nodes
        cy.nodes().addClass("dim");

        // undim clicked node + its neighboring nodes
        node.closedNeighborhood().nodes().removeClass("dim");

        // apply highlight to current selection
        node.addClass("nodeHL");
        node.connectedEdges().addClass("edgeHL");
      };

      // Tooltip behavior
      cy.on("tap", "node", (evt) => {
        const node = evt.target;
        focusOnNode(node);

        const id = node.id();
        const info = instInfo.get(id);
        if (!info) return;

        const countries = Array.from(info.countries);
        const authors = Array.from(info.authors.values()).sort((a, b) =>
          a.localeCompare(b)
        );

        const authorItems = authors
          .slice(0, 25)
          .map((name) => `<li>${escapeHtml(name)}</li>`)
          .join("");

        const moreCount = Math.max(0, authors.length - 25);

        const html = `
          <h3 style="font-family:sans-serif; margin:0 0 6px 0;">${escapeHtml(
            info.name
          )}</h3>

          <div style="font-family:sans-serif; margin-top:6px;">
            <span class="pill">Countries: ${countries.length}</span>
            <span class="pill">Authors: ${authors.length}</span>
          </div>

          <div style="margin-top:8px; font-family:sans-serif">
            <div><b>Country</b>: ${escapeHtml(countries[0] || "—")}${
          countries.length > 1
            ? ` <span class="muted">(+${countries.length - 1} more)</span>`
            : ""
        }</div>
          </div>

          <div style="margin-top:10px; font-family:sans-serif">
            <b>Authors</b>
            <ul>${authorItems || "<li class='muted'>—</li>"}</ul>
            ${
              moreCount
                ? `<div class="muted" style="margin-top:6px;">…and ${moreCount} more</div>`
                : ""
            }
          </div>
        `;

        // Position tooltip near pointer if possible
        const oe = evt.originalEvent;
        if (oe && typeof oe.clientX === "number") {
          showTooltipAt(oe.clientX, oe.clientY, html);
        } else {
          const rp = node.renderedPosition();
          const rect = CY_EL.getBoundingClientRect();
          showTooltipAt(rect.left + rp.x, rect.top + rp.y, html);
        }
      });

      // Click background: clear focus + hide tooltip
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

      cy.on("zoom pan", () => hideTooltip());
    }

    try {
      const resp = await fetch("./mockup_data.csv", { cache: "no-store" });
      if (!resp.ok) throw new Error(`Failed to fetch CSV: HTTP ${resp.status}`);
      const text = await resp.text();

      const rows = parseCsv(text);
      const { elements, instInfo } = buildInstitutionGraph(rows);

      if (!elements.length)
        throw new Error(
          "No institution nodes/edges created. Check 'institution' and 'paper_id' columns."
        );

      render(elements, instInfo);
    } catch (err) {
      console.error(err);
      tooltip.style.display = "none";
      CY_EL.innerHTML = `<div style="padding:16px; color:#b45309;">${err.message}</div>`;
    }
  });
})();
