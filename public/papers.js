(() => {
  window.addEventListener("DOMContentLoaded", async () => {
    const CY_EL = document.getElementById("cy");
    const tooltip = document.getElementById("tooltip");
    if (!CY_EL || !tooltip) return;

    // Register fcose layout. Useless. Delete later!!!
    if (typeof cytoscapeFcose !== "undefined") {
      cytoscape.use(cytoscapeFcose);
    } else {
      console.warn("cytoscape-fcose not loaded; falling back to cose");
    }

    // draggable tooltip
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

    // Papers graph:
    // - nodes = papers
    // - edge between papers if they share >=1 author
    // - edge weight = number of shared authors
    function buildPaperGraph(rows) {
      // paper_id -> info
      const paperInfo = new Map(); // id -> { id, title, year, authors:Map(author_id -> name) }

      // author_id -> Set(paper_id)
      const authorPapers = new Map();

      // Collect paper + authors
      for (const r of rows) {
        const paper_id = normalize(r.paper_id);
        const paper_title = (r.paper_title ?? "").toString().trim();
        const paper_year = (r.paper_year ?? "").toString().trim();
        const author_id = normalize(r.author_id);
        const author_name = (r.author_name ?? "").toString().trim();

        if (!paper_id) continue;

        if (!paperInfo.has(paper_id)) {
          paperInfo.set(paper_id, {
            id: paper_id,
            title: paper_title || paper_id,
            year: paper_year || "",
            authors: new Map(),
          });
        } else {
          const p = paperInfo.get(paper_id);
          if ((!p.title || p.title === p.id) && paper_title)
            p.title = paper_title;
          if (!p.year && paper_year) p.year = paper_year;
        }

        if (author_id) {
          paperInfo
            .get(paper_id)
            .authors.set(author_id, author_name || author_id);

          if (!authorPapers.has(author_id))
            authorPapers.set(author_id, new Set());
          authorPapers.get(author_id).add(paper_id);
        }
      }

      // Build edges by counting shared authors for each paper pair
      const edgeWeights = new Map(); // "a|b" -> count

      for (const papersSet of authorPapers.values()) {
        const papers = Array.from(papersSet).sort();
        if (papers.length < 2) continue;

        for (let i = 0; i < papers.length; i++) {
          for (let j = i + 1; j < papers.length; j++) {
            const a = papers[i];
            const b = papers[j];
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            edgeWeights.set(key, (edgeWeights.get(key) || 0) + 1);
          }
        }
      }

      // Keep only connected papers
      const connected = new Set();
      for (const key of edgeWeights.keys()) {
        const [a, b] = key.split("|");
        connected.add(a);
        connected.add(b);
      }

      const nodes = [];
      for (const [id, info] of paperInfo.entries()) {
        if (!connected.has(id)) continue;

        // store full title in data(label) for "selected label"
        nodes.push({
          data: {
            id,
            label: info.title,
            year: info.year,
            authorCount: info.authors.size,
          },
        });
      }

      const edges = [];
      for (const [key, w] of edgeWeights.entries()) {
        const [source, target] = key.split("|");
        edges.push({ data: { id: key, source, target, weight: w } });
      }

      return { elements: [...nodes, ...edges], paperInfo };
    }

    function render(elements, paperInfo) {
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
              nodeOverlap: 700,
              componentSpacing: 140,
              padding: 60,
              numIter: 3500,
            };

      const cy = cytoscape({
        container: CY_EL,
        elements,
        style: [
          // Base nodes: NO LABEL, size based on authorCount
          {
            selector: "node",
            style: {
              label: "",
              "font-size": 9,
              color: "white",
              "text-valign": "center",
              "text-halign": "center",
              "text-wrap": "wrap",
              "text-max-width": 90,
              "line-height": 1.0,

              "background-color": "#5a6ae6",
              "text-outline-width": 0.7,
              "text-outline-color": "#5a6ae6",

              // size encodes author count
              width: "mapData(authorCount, 1, 20, 28, 70)",
              height: "mapData(authorCount, 1, 20, 28, 70)",
            },
          },

          // Selected node highlight + label
          {
            selector: "node.nodeHL",
            style: {
              label: "data(label)",
              "border-width": 3,
              "border-color": "#00e5ff",
              "underlay-color": "#00e5ff",
              "underlay-opacity": 0.35,
              "underlay-padding": 6,
            },
          },

          // Neighbor nodes: show label too (but no heavy highlight)
          {
            selector: "node.neighborHL",
            style: {
              label: "data(label)",
              "text-outline-width": 0.7,
              "text-outline-color": "#5a6ae6",
            },
          },

          // Edges
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              "line-color": "#999",
              "line-opacity": 0.55,
              width: "mapData(weight, 1, 10, 1, 7)",
            },
          },

          // Highlighted connected edges
          {
            selector: "edge.edgeHL",
            style: {
              "line-color": "#00e5ff",
              "line-opacity": 1,
              "underlay-color": "#00e5ff",
              "underlay-opacity": 0.6,
              "underlay-padding": 6,
              width: "mapData(weight, 1, 10, 2, 10)",
              "transition-property":
                "line-color line-opacity width underlay-opacity underlay-padding",
              "transition-duration": "0.15s",
            },
          },

          // Dim unrelated nodes
          {
            selector: "node.dim",
            style: {
              opacity: 0.15,
              "text-opacity": 0.15,
            },
          },
        ],
        layout: layoutConfig,
      });

      // clear old highlights first
      const clearFocus = () => {
        cy.nodes().removeClass("dim nodeHL neighborHL");
        cy.edges().removeClass("edgeHL");
      };

      const focusOnNode = (node) => {
        // clear previous highlights
        cy.nodes().removeClass("nodeHL neighborHL");
        cy.edges().removeClass("edgeHL");

        // dim all nodes
        cy.nodes().addClass("dim");

        // undim node + neighbor nodes
        const neighNodes = node.closedNeighborhood().nodes();
        neighNodes.removeClass("dim");

        // selected node: strong highlight + label
        node.addClass("nodeHL");

        // neighbor nodes: label visible
        node.neighborhood("node").addClass("neighborHL");

        // edges highlight
        node.connectedEdges().addClass("edgeHL");
      };

      // Tooltip on node tap
      cy.on("tap", "node", (evt) => {
        const node = evt.target;
        focusOnNode(node);

        const id = node.id();
        const info = paperInfo.get(id);
        if (!info) return;

        const authors = Array.from(info.authors.values()).sort((a, b) =>
          a.localeCompare(b)
        );

        const authorItems = authors
          .slice(0, 30)
          .map((name) => `<li>${escapeHtml(name)}</li>`)
          .join("");

        const moreCount = Math.max(0, authors.length - 30);

        const html = `
          <h3 style="font-family:sans-serif; margin:0 0 6px 0;">
            ${escapeHtml(info.title)}
          </h3>

          <div style="font-family:sans-serif" class="muted">
            ${info.year ? `Year: ${escapeHtml(info.year)}` : "Year: —"}
          </div>

          <div style="font-family:sans-serif; margin-top:6px;">
            <span class="pill">Authors: ${authors.length}</span>
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

        const oe = evt.originalEvent;
        if (oe && typeof oe.clientX === "number") {
          showTooltipAt(oe.clientX, oe.clientY, html);
        } else {
          const rp = node.renderedPosition();
          const rect = CY_EL.getBoundingClientRect();
          showTooltipAt(rect.left + rp.x, rect.top + rp.y, html);
        }
      });

      // Background tap clears focus + tooltip
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
      const { elements, paperInfo } = buildPaperGraph(rows);

      if (!elements.length)
        throw new Error(
          "No paper nodes/edges created. Check 'paper_id', 'paper_title', and author columns."
        );

      render(elements, paperInfo);
    } catch (err) {
      console.error(err);
      tooltip.style.display = "none";
      CY_EL.innerHTML = `<div style="padding:16px; color:#b45309;">${err.message}</div>`;
    }
  });
})();
