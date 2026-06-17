import React, { useEffect, useRef, useState, useMemo } from 'react';
import cytoscape from 'cytoscape';
import { Search, Eye, Filter, Code, Info, RefreshCw, ZoomIn, ZoomOut, Maximize, Zap } from 'lucide-react';
import './visualizer.css';

interface GraphElement {
  data: {
    id: string;
    label: string;
    parent?: string;
    isParent?: boolean;
    isPublic?: boolean;
    file?: string;
    body?: string;
    source?: string;
    target?: string;
  };
}

interface GraphData {
  nodes: GraphElement[];
  edges: GraphElement[];
}

export default function Visualizer() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  
  // Local state for search & filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterPublicOnly, setFilterPublicOnly] = useState<boolean>(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const cyContainerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // Fetch graph data from backend
  useEffect(() => {
    fetch('/api/contract-calls')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch call graph');
        return res.json();
      })
      .then((resData) => {
        setData(resData);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Performance optimized via memo: compute filtered elements
  const filteredElements = useMemo(() => {
    if (!data) return [];

    const query = searchQuery.toLowerCase().trim();

    // Determine matching function nodes
    const matches = (node: GraphElement) => {
      if (node.data.isParent) return false;
      
      // Filter by public visibility
      if (filterPublicOnly && !node.data.isPublic) return false;
      
      // Filter by search query
      if (query) {
        const nameMatch = node.data.label.toLowerCase().includes(query);
        const moduleMatch = node.data.parent?.toLowerCase().includes(query) || false;
        return nameMatch || moduleMatch;
      }
      return true;
    };

    // Find active function nodes
    const activeFnNodes = data.nodes.filter(matches);
    const activeFnIds = new Set(activeFnNodes.map((n) => n.data.id));

    // Keep parent nodes only if they have at least one active child node
    const activeParentIds = new Set(
      activeFnNodes.map((n) => n.data.parent).filter(Boolean) as string[]
    );
    const activeParentNodes = data.nodes.filter(
      (n) => n.data.isParent && activeParentIds.has(n.data.id)
    );

    // Keep edges only if both source and target are active function nodes
    const activeEdges = data.edges.filter(
      (e) => activeFnIds.has(e.data.source || '') && activeFnIds.has(e.data.target || '')
    );

    return [...activeParentNodes, ...activeFnNodes, ...activeEdges];
  }, [data, searchQuery, filterPublicOnly]);

  // Selected node details computed via memo
  const selectedNodeDetails = useMemo(() => {
    if (!data || !selectedNodeId) return null;
    const node = data.nodes.find((n) => n.data.id === selectedNodeId);
    if (!node || node.data.isParent) return null;

    // Find incoming edges (callers)
    const callers = data.edges
      .filter((e) => e.data.target === selectedNodeId)
      .map((e) => {
        const callerNode = data.nodes.find((n) => n.data.id === e.data.source);
        return {
          id: e.data.source || '',
          label: callerNode ? callerNode.data.label : (e.data.source || ''),
          file: callerNode ? callerNode.data.file : ''
        };
      });

    // Find outgoing edges (callees)
    const callees = data.edges
      .filter((e) => e.data.source === selectedNodeId)
      .map((e) => {
        const calleeNode = data.nodes.find((n) => n.data.id === e.data.target);
        return {
          id: e.data.target || '',
          label: calleeNode ? calleeNode.data.label : (e.data.target || ''),
          file: calleeNode ? calleeNode.data.file : ''
        };
      });

    return {
      id: node.data.id,
      name: node.data.label,
      file: node.data.file || '',
      isPublic: node.data.isPublic || false,
      body: node.data.body || '',
      callers,
      callees
    };
  }, [data, selectedNodeId]);

  // Setup/Update Cytoscape Instance
  useEffect(() => {
    if (!cyContainerRef.current || filteredElements.length === 0) return;

    // Initialize Cytoscape core
    const cy = cytoscape({
      container: cyContainerRef.current,
      elements: JSON.parse(JSON.stringify(filteredElements)), // Clone for cytoscape mutation safety
      style: [
        {
          selector: 'node',
          style: {
            'font-family': 'Outfit, system-ui, sans-serif',
            'font-weight': '500',
            'label': 'data(label)',
            'color': '#cbd5e1',
            'text-valign': 'center',
            'text-halign': 'right',
            'text-margin-x': 8,
            'background-color': '#475569',
            'width': 36,
            'height': 36,
            'transition-property': 'background-color, border-color, border-width, width, height',
            'transition-duration': 0.2
          } as any
        },
        {
          selector: 'node[?isPublic]',
          style: {
            'background-color': '#10b981' // emerald for public entry points
          }
        },
        {
          selector: 'node[!isPublic]',
          style: {
            'background-color': '#6366f1' // indigo for internal contract helpers
          }
        },
        {
          selector: 'node:parent',
          style: {
            'label': 'data(label)',
            'background-opacity': 0.15,
            'background-color': '#1e293b',
            'border-width': 1.5,
            'border-color': '#475569',
            'border-style': 'dashed',
            'text-valign': 'top',
            'text-halign': 'center',
            'text-margin-y': -8,
            'color': '#94a3b8',
            'font-size': 13,
            'font-weight': 600
          } as any
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'width': 2,
            'line-color': '#64748b',
            'target-arrow-color': '#64748b',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 1.1,
            'opacity': 0.65,
            'transition-property': 'line-color, target-arrow-color, width, opacity',
            'transition-duration': 0.2
          } as any
        },
        // Selected node styling
        {
          selector: 'node:selected',
          style: {
            'border-width': 4,
            'border-color': '#3b82f6',
            'width': 40,
            'height': 40
          } as any
        },
        // Hover styling
        {
          selector: 'node.highlighted',
          style: {
            'border-width': 3,
            'border-color': '#60a5fa',
            'background-color': '#2563eb'
          } as any
        },
        {
          selector: 'edge.highlighted',
          style: {
            'line-color': '#60a5fa',
            'target-arrow-color': '#60a5fa',
            'width': 4,
            'opacity': 1.0
          } as any
        },
        {
          selector: 'node.dimmed',
          style: {
            'opacity': 0.25
          }
        },
        {
          selector: 'edge.dimmed',
          style: {
            'opacity': 0.1
          }
        }
      ],
      layout: {
        name: 'cose',
        nodeOverlap: 20,
        componentSpacing: 120,
        nodeRepulsion: () => 4096,
        nestingFactor: 1.2,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0,
        fit: true,
        padding: 50
      } as any
    });

    cyRef.current = cy;

    // Node selection handler
    cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      if (!node.isParent()) {
        setSelectedNodeId(node.id());
      }
    });

    // Hover highlighting logic
    cy.on('mouseover', 'node', (evt) => {
      const node = evt.target;
      if (node.isParent()) return;

      // Dim everything
      cy.elements().addClass('dimmed');
      node.removeClass('dimmed').addClass('highlighted');

      // Highlight outgoing connections
      node.outgoers().removeClass('dimmed').addClass('highlighted');
      // Highlight incoming connections
      node.incomers().removeClass('dimmed').addClass('highlighted');
    });

    cy.on('mouseout', 'node', () => {
      cy.elements().removeClass('dimmed').removeClass('highlighted');
    });

    // Fit layout on window resize
    const handleResize = () => {
      cy.resize();
      cy.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cy.destroy();
    };
  }, [filteredElements]);

  // Sync cytoscape selection when selectedNodeId state updates from sidebar clicks
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !selectedNodeId) return;

    cy.$('node').unselect();
    const ele = cy.getElementById(selectedNodeId);
    if (ele.length > 0) {
      ele.select();
      cy.animate({
        center: { eles: ele },
        zoom: Math.max(cy.zoom(), 1.2),
        duration: 500
      });
    }
  }, [selectedNodeId]);

  // Layout helper functions
  const handleResetLayout = () => {
    const cy = cyRef.current;
    if (cy) {
      cy.layout({ name: 'cose', fit: true, padding: 50 } as any).run();
      setSelectedNodeId(null);
    }
  };

  const handleZoomIn = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom(cy.zoom() * 1.2);
  };

  const handleZoomOut = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom(cy.zoom() / 1.2);
  };

  const handleFit = () => {
    const cy = cyRef.current;
    if (cy) cy.fit();
  };

  return (
    <div className="visualizer-container">
      {/* Background visual elements */}
      <div className="bg-glow bg-glow-1"></div>
      <div className="bg-glow bg-glow-2"></div>

      {/* Header bar */}
      <header className="visualizer-header">
        <div className="header-logo">
          <div className="logo-icon">
            <Zap size={20} />
          </div>
          <h1>Vero Soroban Call Graph</h1>
        </div>
        
        {/* Controls */}
        <div className="header-actions">
          <button onClick={handleResetLayout} title="Reset Layout" className="btn-action">
            <RefreshCw size={18} />
            <span>Reset Layout</span>
          </button>
          <div className="divider"></div>
          <button onClick={handleZoomIn} title="Zoom In" className="btn-icon">
            <ZoomIn size={18} />
          </button>
          <button onClick={handleZoomOut} title="Zoom Out" className="btn-icon">
            <ZoomOut size={18} />
          </button>
          <button onClick={handleFit} title="Fit Graph" className="btn-icon">
            <Maximize size={18} />
          </button>
        </div>
      </header>

      <main className="visualizer-main">
        {/* Sidebar for Filters & Search */}
        <aside className="sidebar-left glass-panel">
          <div className="sidebar-section">
            <h3>Search & Filters</h3>
            <div className="search-box">
              <Search size={18} className="search-icon" />
              <input
                type="text"
                placeholder="Search functions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="filter-options">
              <label className="checkbox-container">
                <input
                  type="checkbox"
                  checked={filterPublicOnly}
                  onChange={(e) => setFilterPublicOnly(e.target.checked)}
                />
                <span className="checkbox-checkmark"></span>
                <span className="checkbox-label">Public Entry Points Only</span>
              </label>
            </div>
          </div>

          <div className="sidebar-section legend-section">
            <h3>Legend</h3>
            <div className="legend-item">
              <span className="legend-badge badge-public"></span>
              <span>Public Contract Method (pub fn)</span>
            </div>
            <div className="legend-item">
              <span className="legend-badge badge-private"></span>
              <span>Internal Helper (fn)</span>
            </div>
            <div className="legend-item">
              <span className="legend-badge badge-container"></span>
              <span>Module Namespace (file)</span>
            </div>
          </div>

          {loading && (
            <div className="status-message loading-state">
              <RefreshCw size={24} className="spin-icon" />
              <p>Analyzing Soroban contracts...</p>
            </div>
          )}

          {error && (
            <div className="status-message error-state">
              <p>Error: {error}</p>
            </div>
          )}

          {!loading && !error && filteredElements.length === 0 && (
            <div className="status-message empty-state">
              <Info size={24} />
              <p>No matching elements found.</p>
            </div>
          )}
        </aside>

        {/* Canvas container */}
        <div className="canvas-wrapper">
          <div ref={cyContainerRef} className="cytoscape-canvas" />
        </div>

        {/* Selected Node Details (Right Sidebar) */}
        <aside className={`sidebar-right glass-panel ${selectedNodeDetails ? 'open' : ''}`}>
          {selectedNodeDetails ? (
            <div className="details-container">
              <div className="details-header">
                <h2>{selectedNodeDetails.name}</h2>
                <span className={`visibility-badge ${selectedNodeDetails.isPublic ? 'public' : 'private'}`}>
                  {selectedNodeDetails.isPublic ? 'Public Entrypoint' : 'Internal Helper'}
                </span>
              </div>

              <div className="details-meta">
                <div className="meta-item">
                  <span className="meta-label">File:</span>
                  <span className="meta-value">{selectedNodeDetails.file}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Signature:</span>
                  <span className="meta-value code-font">
                    {selectedNodeDetails.isPublic ? 'pub fn ' : 'fn '}{selectedNodeDetails.name}
                  </span>
                </div>
              </div>

              {/* Callers & Callees lists */}
              <div className="relations-section">
                <h3>Called By (Callers)</h3>
                {selectedNodeDetails.callers.length > 0 ? (
                  <ul className="relation-list">
                    {selectedNodeDetails.callers.map((caller) => (
                      <li key={caller.id} onClick={() => setSelectedNodeId(caller.id)}>
                        <span className="relation-name">{caller.label}</span>
                        <span className="relation-file">{caller.file}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="no-relations">No callers in contracts</p>
                )}
              </div>

              <div className="relations-section">
                <h3>Calls (Callees)</h3>
                {selectedNodeDetails.callees.length > 0 ? (
                  <ul className="relation-list">
                    {selectedNodeDetails.callees.map((callee) => (
                      <li key={callee.id} onClick={() => setSelectedNodeId(callee.id)}>
                        <span className="relation-name">{callee.label}</span>
                        <span className="relation-file">{callee.file}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="no-relations">No callees in contracts</p>
                )}
              </div>

              {/* Function Code Snippet */}
              {selectedNodeDetails.body && (
                <div className="code-section">
                  <div className="code-header">
                    <Code size={16} />
                    <span>Implementation</span>
                  </div>
                  <pre className="code-block">
                    <code>{selectedNodeDetails.body}</code>
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="no-selection">
              <Info size={32} />
              <p>Select a function node to view its implementation details and call context.</p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
