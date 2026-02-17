(() => {
  window.addEventListener("DOMContentLoaded", async () => {
    const CY_EL = document.getElementById("cy");
    const tooltip = document.getElementById("tooltip");
    if (!CY_EL || !tooltip) return;

    // tooltip draggable ---
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
        // only drag with primary button / touch
        if (e.button != null && e.button !== 0) return;

        dragging = true;
        tooltip.setPointerCapture(e.pointerId);

        const rect = tooltip.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;

        // prevent text selection while dragging
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
      //check if string is null or undefined, else default to empty string
      //remove space
      //remove BOM \uFEFF
      return (s ?? "")
        .toString()
        .trim()
        .replace(/^\uFEFF/, "");
    }

    //turn CSV to array
    //each row is an element
    function parseCsv(text) {
      const res = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        delimiter: ";",
      });

      //filter empty row
      //Keep row only if at least one field is not empty after trimming
      return (res.data || []).filter((r) =>
        Object.keys(r).some((k) => (r[k] ?? "").toString().trim() !== "")
      );
    }

    // Build model for Layer 1 + author details for tooltip
    function buildAuthorGraph(rows) {
      // author_id -> {
      //   id, name, institutions:Set, countries:Set,
      //   papers: Map(paper_id -> {title, year})
      // }
      const authorInfo = new Map();

      //build a list of who authored each paper
      // paper_id -> Set(author_id)
      const paperAuthors = new Map();

      //collect info for tooltip
      for (const r of rows) {
        const author_id = normalize(r.author_id);
        const author_name = (r.author_name ?? "").toString().trim();
        const paper_id = normalize(r.paper_id);
        const paper_title = (r.paper_title ?? "").toString().trim();
        const paper_year = (r.paper_year ?? "").toString().trim();
        const institution = (r.institution ?? "").toString().trim();
        const country = (r.country ?? "").toString().trim();

        if (!author_id || !paper_id) continue;

        if (!authorInfo.has(author_id)) {
          authorInfo.set(author_id, {
            id: author_id,
            name: author_name || author_id,
            institutions: new Set(),
            countries: new Set(),
            papers: new Map(),
          });
        }

        const a = authorInfo.get(author_id);
        if ((!a.name || a.name === a.id) && author_name) a.name = author_name;
        if (institution) a.institutions.add(institution);
        if (country) a.countries.add(country);

        if (!a.papers.has(paper_id)) {
          a.papers.set(paper_id, {
            id: paper_id,
            title: paper_title || paper_id,
            year: paper_year || "",
          });
        } else {
          const p = a.papers.get(paper_id);
          if ((!p.title || p.title === p.id) && paper_title)
            p.title = paper_title;
          if (!p.year && paper_year) p.year = paper_year;
        }

        if (!paperAuthors.has(paper_id)) paperAuthors.set(paper_id, new Set());
        paperAuthors.get(paper_id).add(author_id);
      }

      // Aggregate edges by author pair (A|B)
      const edgeCounts = new Map();
      const connected = new Set();

      //For each paper, take its authors
      //For every pair of authors on that paper, add +1 to their edge weight
      //So if A & B wrote 3 papers together, weight becomes 3
      for (const set of paperAuthors.values()) {
        const list = Array.from(set).sort();
        if (list.length < 2) continue;

        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i],
              b = list[j];
            const key = `${a}|${b}`;
            edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
            //tracks authors who have at least one collaboration. isolated nodes are hidden
            connected.add(a);
            connected.add(b);
          }
        }
      }

      // Build cytoscape elements
      //nodes: { data: { id, label } }
      const nodes = [];
      for (const info of authorInfo.values()) {
        if (!connected.has(info.id)) continue;

        nodes.push({
          data: {
            id: info.id,
            label: info.name,
            paperCount: info.papers.size, // number of papers by this author
          },
        });
      }

      //edges: { data: { id, source, target, weight } }
      const edges = [];
      for (const [key, w] of edgeCounts.entries()) {
        const [source, target] = key.split("|");
        edges.push({ data: { id: key, source, target, weight: w } });
      }

      return { elements: [...nodes, ...edges], authorInfo };
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
      tooltip.style.left = `${x + pad}px`;
      tooltip.style.top = `${y + pad}px`;

      const rect = tooltip.getBoundingClientRect();
      let left = x + pad;
      let top = y + pad;

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

    function render(elements, authorInfo) {
      const layoutConfig =
        typeof cytoscapeFcose !== "undefined"
          ? {
              name: "fcose",
              quality: "default",
              animate: true,
              nodeSeparation: 140,
              nodeRepulsion: 10000,
              idealEdgeLength: 170,
              gravity: 0.25,
              numIter: 2500,
              padding: 60,
              randomize: true,
            }
          : {
              name: "cose",
              animate: true,
              nodeRepulsion: 14000,
              idealEdgeLength: 190,
              nodeOverlap: 500,
              componentSpacing: 140,
              padding: 60,
              numIter: 3000,
            };

      const cy = cytoscape({
        container: CY_EL,
        elements,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "font-size": "mapData(paperCount, 1, 20, 8, 12)",
              color: "white",
              "text-valign": "center",
              "text-halign": "center",
              "text-wrap": "wrap",
              "text-max-width": 10,
              "background-color": "#8767a8",
              "line-height": 0.95,
              "text-outline-width": 0.7,
              "text-outline-color": "#8767a8",
              width: "mapData(paperCount, 1, 20, 30, 80)",
              height: "mapData(paperCount, 1, 20, 30, 80)",
            },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              "line-color": "#999",
              "line-opacity": 0.6,
              width: "mapData(weight, 0, 8, 0, 6)",
            },
          },
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
          {
            selector: "edge.edgeHL",
            style: {
              "line-color": "#00e5ff",
              "line-opacity": 1,
              width: "mapData(weight, 0, 8, 2, 10)",
              "transition-property":
                "line-color line-opacity width underlay-opacity underlay-padding",
              "transition-duration": "0.15s",
            },
          },
          // dimmed look
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

      const clearFocus = () => {
        cy.nodes().removeClass("dim nodeHL");
        cy.edges().removeClass("edgeHL");
      };

      const focusOnNode = (node) => {
        // Dim ALL nodes first
        cy.nodes().addClass("dim");

        // Undim only clicked node and directly connected neighbor nodes
        const neighborhoodNodes = node.closedNeighborhood().nodes();
        neighborhoodNodes.removeClass("dim");

        // Add highlights
        node.addClass("nodeHL");
        node.connectedEdges().addClass("edgeHL");
      };

      const clearHighlights = () => {
        cy.nodes().removeClass("nodeHL");
        cy.edges().removeClass("edgeHL");
      };

      const highlightNeighborhood = (node) => {
        clearHighlights();
        node.addClass("nodeHL");
        node.connectedEdges().addClass("edgeHL");
      };

      // Tooltip behavior
      cy.on("tap", "node", (evt) => {
        const node = evt.target;
        highlightNeighborhood(node);
        focusOnNode(node);

        const id = node.id();
        const info = authorInfo.get(id);

        if (!info) return;

        // Build tooltip HTML
        const institutions = Array.from(info.institutions);
        const countries = Array.from(info.countries);

        const papers = Array.from(info.papers.values()).sort((a, b) =>
          (b.year || "").localeCompare(a.year || "")
        ); // newest first

        const paperItems = papers
          .slice(0, 25)
          .map((p) => {
            const title = escapeHtml(p.title);
            const year = escapeHtml(p.year);
            return `<li>${title}${
              year ? ` <span class="muted">(${year})</span>` : ""
            }</li>`;
          })
          .join("");

        const moreCount = Math.max(0, papers.length - 25);

        const html = `
          <h3 style="font-family:sans-serif">${escapeHtml(info.name)}</h3>
          <div  style="font-family:sans-serif" class="muted">Author ID: ${escapeHtml(
            info.id
          )}</div>

          <div style="margin-top:8px; font-family:sans-serif">
            <span class="pill">Institutions: ${institutions.length}</span>
            <span class="pill">Countries: ${countries.length}</span>
            <span class="pill">Papers: ${papers.length}</span>
          </div>

          <div style="margin-top:8px; font-family:sans-serif">
            <div><b>Institution</b>: ${escapeHtml(institutions[0] || "—")}${
          institutions.length > 1
            ? ` <span class="muted">(+${institutions.length - 1} more)</span>`
            : ""
        }</div>
            <div><b>Country</b>: ${escapeHtml(countries[0] || "—")}${
          countries.length > 1
            ? ` <span class="muted">(+${countries.length - 1} more)</span>`
            : ""
        }</div>
          </div>

          <div style="margin-top:10px; font-family:sans-serif">
            <b>Papers</b>
            <ul>${paperItems || "<li class='muted'>—</li>"}</ul>
            ${
              moreCount
                ? `<div class="muted" style="margin-top:6px;">…and ${moreCount} more</div>`
                : ""
            }
          </div>
        `;

        // Use mouse position if available; otherwise use node rendered position
        const oe = evt.originalEvent;
        if (oe && typeof oe.clientX === "number") {
          showTooltipAt(oe.clientX, oe.clientY, html);
        } else {
          const rp = node.renderedPosition();
          const rect = CY_EL.getBoundingClientRect();
          showTooltipAt(rect.left + rp.x, rect.top + rp.y, html);
        }
      });

      cy.on("tap", (evt) => {
        if (evt.target === cy) {
          hideTooltip();
          clearHighlights();
          clearFocus();
        }
      });

      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          hideTooltip();
          clearHighlights();
          clearFocus();
        }
      });

      // If user scrolls/zooms, hide tooltip
      cy.on("zoom pan", () => hideTooltip());
    }

    try {
      const resp = await fetch("./mockup_data.csv", { cache: "no-store" });
      if (!resp.ok) throw new Error(`Failed to fetch CSV: HTTP ${resp.status}`);
      const text = await resp.text();

      const rows = parseCsv(text);
      const { elements, authorInfo } = buildAuthorGraph(rows);

      if (!elements.length)
        throw new Error(
          "No author nodes/edges created. Check 'author_id' and 'paper_id'."
        );

      render(elements, authorInfo);
    } catch (err) {
      console.error(err);
      tooltip.style.display = "none";
      CY_EL.innerHTML = `<div style="padding:16px; color:#b45309;">${err.message}</div>`;
    }
  });
})();
