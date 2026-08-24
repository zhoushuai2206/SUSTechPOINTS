/**
 * ClassifyAnnotator - Point Cloud Classification Annotation Module
 * Provides tools for manually classifying point cloud data with polygon selection
 *
 * @version 2.0.0
 * @optimized For performance, maintainability and extensibility
 */

import * as THREE from './lib/three.module.js';

// ============================================================================
// Constants & Configuration
// ============================================================================

const CONFIG = {
    // Selection settings
    SELECTION: {
        FILL_COLOR: 'rgba(255, 255, 0, 0.2)',
        BORDER_COLOR: 'yellow',
        VERTEX_OUTER_COLOR: '#FFA500',
        VERTEX_INNER_COLOR: 'yellow',
        VERTEX_OUTER_RADIUS: 8,
        VERTEX_INNER_RADIUS: 5,
        PREVIEW_RADIUS: 5,
        LINE_WIDTH: 2,
        DASH_PATTERN: [5, 5],
        PREVIEW_DASH_PATTERN: [2, 2]
    },

    // Snapping settings
    SNAPPING: {
        MAX_RADIUS_PX: 200
    },

    // Highlight settings
    HIGHLIGHT: {
        SIZE_MULTIPLIER: 3,
        RENDER_ORDER: 999
    },

    // History settings
    HISTORY: {
        MAX_SIZE: 50
    },

    // Debug settings
    DEBUG: {
        ENABLED: true, // Set to true for development/debugging
        LOG_PREFIX: '[ClassifyAnnotator]'
    }
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Conditional logger that respects debug settings
 */
const Logger = {
    log(...args) {
        if (CONFIG.DEBUG.ENABLED) {
            console.log(CONFIG.DEBUG.LOG_PREFIX, ...args);
        }
    },
    warn(...args) {
        console.warn(CONFIG.DEBUG.LOG_PREFIX, ...args);
    },
    error(...args) {
        console.error(CONFIG.DEBUG.LOG_PREFIX, ...args);
    }
};

/**
 * Check if point is inside polygon using ray casting algorithm
 * @param {number} x - Point X coordinate
 * @param {number} y - Point Y coordinate
 * @param {Array<{x: number, y: number}>} polygon - Polygon vertices
 * @returns {boolean}
 */
function isPointInPolygon(x, y, polygon) {
    let inside = false;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;

        const intersect = ((yi > y) !== (yj > y)) &&
            (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

        if (intersect) {
            inside = !inside;
        }
    }

    return inside;
}

// ============================================================================
// Global Registry for Active Annotators
// ============================================================================

const ClassifyAnnotatorRegistry = {
    activeAnnotators: new Map(),

    setActive(viewContainer, annotator) {
        const existing = this.activeAnnotators.get(viewContainer);
        if (existing && existing !== annotator) {
            Logger.log('Deactivating previous annotator for frame:', existing.lidar?.frameInfo?.frame);
            existing.isActive = false;
            if (existing.overlayCanvas) {
                existing.overlayCanvas.style.display = 'none';
            }
        }
        this.activeAnnotators.set(viewContainer, annotator);
    },

    remove(viewContainer) {
        this.activeAnnotators.delete(viewContainer);
    },

    /**
     * Return the currently active annotator (there is typically at most one).
     * Used by the module-level global UI handlers so that per-frame
     * ClassifyAnnotator instances don't each re-bind the same buttons.
     */
    getActive() {
        for (const ann of this.activeAnnotators.values()) {
            if (ann && ann.isActive) return ann;
        }
        return null;
    }
};

// ============================================================================
// Global (one-time) UI bindings for the Classify panel
// ----------------------------------------------------------------------------
// Rationale: A new ClassifyAnnotator is instantiated for every frame switch
// (see editor.js -> attachWorld). If each instance bound its own click/change
// listeners to the shared panel buttons (classify-undo-btn, classify-clear-btn,
// classify-save-btn, ...), listeners would accumulate and a single click would
// fire N handlers — producing N sequential confirm/alert dialogs that appear
// impossible to dismiss (the user closes one and the next one appears).
//
// We instead bind the shared UI **once** and dispatch to whichever annotator
// is currently active in the registry.
// ============================================================================
let _classifyGlobalUIBound = false;

function bindClassifyGlobalUIOnce() {
    if (_classifyGlobalUIBound) return;
    _classifyGlobalUIBound = true;

    const on = (id, event, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, fn);
    };

    // Classify Mode master checkbox: activate the annotator that belongs to
    // the world currently displayed by the editor; deactivate whichever is
    // currently active when unchecked.
    on('cfg-classify-mode-checkbox', 'change', (e) => {
        if (e.target.checked) {
            const currentAnn =
                (typeof window !== 'undefined' &&
                    window.editor?.data?.world?.lidar?.classifyAnnotator) ||
                ClassifyAnnotatorRegistry.getActive();
            if (currentAnn) currentAnn.setActive(true);
        } else {
            const active = ClassifyAnnotatorRegistry.getActive();
            if (active) active.setActive(false);
        }
    });

    on('classify-select-points', 'change', (e) => {
        const ann = ClassifyAnnotatorRegistry.getActive();
        if (ann) ann.setSelectPointsMode(e.target.checked);
    });

    on('classify-select-all-btn', 'click', () => {
        const ann = ClassifyAnnotatorRegistry.getActive();
        if (ann) ann.selectAllPoints();
    });

    on('classify-apply-btn', 'click', () => {
        const ann = ClassifyAnnotatorRegistry.getActive();
        if (!ann) return;
        const selectedRadio = document.querySelector('input[name="classify-value"]:checked');
        if (selectedRadio) ann.applyClassify(parseInt(selectedRadio.value));
    });

    on('classify-undo-btn', 'click', () => {
        const ann = ClassifyAnnotatorRegistry.getActive();
        if (ann) ann.undo();
    });

    on('classify-clear-btn', 'click', () => {
        const ann = ClassifyAnnotatorRegistry.getActive();
        if (ann) ann.clearAllClassifications();
    });

    on('classify-save-btn', 'click', () => {
        const ann = ClassifyAnnotatorRegistry.getActive();
        if (ann) ann.saveToPCD();
    });

    // Close button — exit Classify Mode by unchecking the master checkbox.
    on('classify-close-btn', 'click', () => {
        const modeCheckbox = document.getElementById('cfg-classify-mode-checkbox');
        if (modeCheckbox) {
            modeCheckbox.checked = false;
            modeCheckbox.dispatchEvent(new Event('change'));
        }
    });
}

// Panel-drag binding is also global (the panel DOM node is stable across
// frame switches). Guarded so it only runs once.
let _classifyPanelDragBound = false;
function setupClassifyPanelDraggingOnce() {
    if (_classifyPanelDragBound) return;
    const panel = document.getElementById('classify-panel');
    const header = document.getElementById('classify-panel-header');
    if (!panel || !header) return;
    _classifyPanelDragBound = true;

    let isDragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        header.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const maxLeft = window.innerWidth - panel.offsetWidth;
        const maxTop = window.innerHeight - panel.offsetHeight;
        panel.style.left = Math.max(0, Math.min(startLeft + dx, maxLeft)) + 'px';
        panel.style.top = Math.max(0, Math.min(startTop + dy, maxTop)) + 'px';
        panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'move';
        }
    });
}

// ============================================================================
// UI State Manager - Handles checkbox state save/restore
// ============================================================================

class UIStateManager {
    constructor() {
        this.savedStates = {
            hideBox: false,
            hideId: false,
            hideCategory: false,
            colorObj: null,
            colorPoints: null
        };
        // Guards against re-saving while Classify Mode is already on. Switching
        // frames rebuilds the annotator and re-runs the entry path, so without
        // this the classify-mode values (hide boxes / color by classify) would
        // overwrite the user's original settings and never be restored on exit.
        this.hasSaved = false;
    }

    /**
     * Save current UI states. No-op while a save is already in effect.
     */
    save() {
        if (this.hasSaved) return;
        this.saveCheckbox('cfg-hide-box-checkbox', 'hideBox');
        this.saveCheckbox('cfg-hide-id-checkbox', 'hideId');
        this.saveCheckbox('cfg-hide-category-checkbox', 'hideCategory');
        this.saveColorObj();
        this.saveColorPoints();
        this.hasSaved = true;
    }

    /**
     * Restore saved UI states
     */
    restore() {
        this.restoreCheckbox('cfg-hide-box-checkbox', 'hideBox');
        this.restoreCheckbox('cfg-hide-id-checkbox', 'hideId');
        this.restoreCheckbox('cfg-hide-category-checkbox', 'hideCategory');
        this.restoreColorObj();
        this.restoreColorPoints();
        this.hasSaved = false;
    }

    /**
     * Apply Classify Mode UI settings (hide boxes, etc.)
     */
    applyClassifyModeSettings() {
        this.setCheckboxIfFalse('cfg-hide-box-checkbox', true);
        this.setCheckboxIfFalse('cfg-hide-id-checkbox', true);
        this.setCheckboxIfFalse('cfg-hide-category-checkbox', true);
        this.setColorObjToNo();
        this.setColorPointsToClassify();
    }

    saveCheckbox(elementId, stateKey) {
        const checkbox = document.getElementById(elementId);
        if (checkbox) {
            this.savedStates[stateKey] = checkbox.checked;
        }
    }

    restoreCheckbox(elementId, stateKey) {
        const checkbox = document.getElementById(elementId);
        if (checkbox && checkbox.checked !== this.savedStates[stateKey]) {
            checkbox.checked = this.savedStates[stateKey];
            checkbox.dispatchEvent(new Event('change'));
        }
    }

    setCheckboxIfFalse(elementId, value) {
        const checkbox = document.getElementById(elementId);
        if (checkbox && !checkbox.checked) {
            checkbox.checked = value;
            checkbox.dispatchEvent(new Event('change'));
        }
    }

    saveColorObj() {
        const colorObjectSelect = document.getElementById('cfg-color-object-scheme');
        if (window.pointsGlobalConfig && colorObjectSelect) {
            this.savedStates.colorObj = window.pointsGlobalConfig.color_obj;
        }
    }

    restoreColorObj() {
        const colorObjectSelect = document.getElementById('cfg-color-object-scheme');
        if (window.pointsGlobalConfig && colorObjectSelect && this.savedStates.colorObj) {
            colorObjectSelect.value = this.savedStates.colorObj;
            window.pointsGlobalConfig.color_obj = this.savedStates.colorObj;
        }
    }

    setColorObjToNo() {
        const colorObjectSelect = document.getElementById('cfg-color-object-scheme');
        if (window.pointsGlobalConfig && colorObjectSelect) {
            colorObjectSelect.value = 'no';
            window.pointsGlobalConfig.color_obj = 'no';
        }
    }

    saveColorPoints() {
        const colorPointsSelect = document.getElementById('cfg-color-points-select');
        if (window.pointsGlobalConfig && colorPointsSelect) {
            this.savedStates.colorPoints = window.pointsGlobalConfig.color_points;
        }
    }

    restoreColorPoints() {
        const colorPointsSelect = document.getElementById('cfg-color-points-select');
        if (window.pointsGlobalConfig && colorPointsSelect && this.savedStates.colorPoints) {
            colorPointsSelect.value = this.savedStates.colorPoints;
            window.pointsGlobalConfig.color_points = this.savedStates.colorPoints;
            // Trigger color update
            if (window.editor && window.editor.data && window.editor.data.worldList) {
                window.editor.data.worldList.forEach(w => {
                    if (w.lidar && w.lidar.color_points) {
                        w.lidar.color_points();
                        w.lidar.update_points_color();
                    }
                });
            }
        }
    }

    setColorPointsToClassify() {
        const colorPointsSelect = document.getElementById('cfg-color-points-select');
        if (window.pointsGlobalConfig && colorPointsSelect) {
            colorPointsSelect.value = 'classify';
            window.pointsGlobalConfig.color_points = 'classify';
            // Setting the config alone leaves already-loaded worlds with their
            // previous (mono/intensity) vertex colors, so recolor them now.
            this.refreshPointsColor();
        }
    }

    /**
     * Recolor every loaded world with the current color_points scheme.
     * The classify palette is fetched asynchronously at bootstrap, so when it
     * is not ready yet we recolor again once it resolves.
     */
    refreshPointsColor() {
        const recolor = () => {
            if (!window.editor || !window.editor.data || !window.editor.data.worldList) {
                return;
            }
            window.editor.data.worldList.forEach(w => {
                if (w.lidar && w.lidar.color_points) {
                    w.lidar.color_points();
                    w.lidar.update_points_color();
                }
            });
            window.editor.render();
        };

        recolor();

        if (!window.classifyClassMap && window.classifyClassMapReady) {
            window.classifyClassMapReady.then(recolor);
        }
    }

}

// Classify Mode owns a single, app-wide UI state snapshot: the panel and the
// config widgets are shared DOM, and each frame switch builds a new
// ClassifyAnnotator. A per-instance manager would take its snapshot *after*
// classify-mode settings had been applied by the previous instance.
const sharedUIStateManager = new UIStateManager();

// ============================================================================
// Canvas Overlay Renderer - Handles all canvas drawing operations
// ============================================================================

class CanvasOverlayRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext('2d') : null;
    }

    updateCanvas(canvas) {
        this.canvas = canvas;
        this.ctx = canvas ? canvas.getContext('2d') : null;
    }

    clear() {
        if (!this.ctx || !this.canvas) return;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Draw polygon vertices with visual indicators
     * @param {Array<{x: number, y: number}>} vertices - Polygon vertices
     */
    drawVertices(vertices) {
        if (!this.ctx) return;

        const { VERTEX_OUTER_COLOR, VERTEX_INNER_COLOR, VERTEX_OUTER_RADIUS,
                VERTEX_INNER_RADIUS, LINE_WIDTH } = CONFIG.SELECTION;

        for (const vertex of vertices) {
            // Outer ring
            this.ctx.beginPath();
            this.ctx.arc(vertex.x, vertex.y, VERTEX_OUTER_RADIUS, 0, 2 * Math.PI);
            this.ctx.strokeStyle = VERTEX_OUTER_COLOR;
            this.ctx.lineWidth = LINE_WIDTH;
            this.ctx.stroke();

            // Inner circle
            this.ctx.beginPath();
            this.ctx.arc(vertex.x, vertex.y, VERTEX_INNER_RADIUS, 0, 2 * Math.PI);
            this.ctx.fillStyle = VERTEX_INNER_COLOR;
            this.ctx.fill();
        }
    }

    /**
     * Draw polygon fill and border
     * @param {Array<{x: number, y: number}>} vertices - Polygon vertices
     * @param {boolean} closed - Whether to close the polygon
     */
    drawPolygonPath(vertices, closed = true) {
        if (!this.ctx || vertices.length === 0) return;

        const { FILL_COLOR, BORDER_COLOR, LINE_WIDTH } = CONFIG.SELECTION;

        this.ctx.beginPath();
        this.ctx.moveTo(vertices[0].x, vertices[0].y);

        for (let i = 1; i < vertices.length; i++) {
            this.ctx.lineTo(vertices[i].x, vertices[i].y);
        }

        if (closed) {
            this.ctx.closePath();
            this.ctx.fillStyle = FILL_COLOR;
            this.ctx.fill();
        }

        this.ctx.strokeStyle = BORDER_COLOR;
        this.ctx.lineWidth = LINE_WIDTH;
        this.ctx.stroke();
    }

    /**
     * Draw a dashed preview line to mouse position
     * @param {Array<{x: number, y: number}>} vertices - Current polygon vertices
     * @param {number} mouseX - Mouse X position
     * @param {number} mouseY - Mouse Y position
     */
    drawPreviewLine(vertices, mouseX, mouseY) {
        if (!this.ctx || vertices.length === 0) return;

        const { BORDER_COLOR, LINE_WIDTH, DASH_PATTERN, PREVIEW_DASH_PATTERN, PREVIEW_RADIUS } = CONFIG.SELECTION;

        // Line to mouse
        this.ctx.beginPath();
        this.ctx.moveTo(vertices[0].x, vertices[0].y);
        for (let i = 1; i < vertices.length; i++) {
            this.ctx.lineTo(vertices[i].x, vertices[i].y);
        }
        this.ctx.lineTo(mouseX, mouseY);

        // Dashed line back to first point
        this.ctx.setLineDash(DASH_PATTERN);
        this.ctx.lineTo(vertices[0].x, vertices[0].y);
        this.ctx.setLineDash([]);

        this.ctx.strokeStyle = BORDER_COLOR;
        this.ctx.lineWidth = LINE_WIDTH;
        this.ctx.stroke();

        // Preview circle at mouse position
        this.ctx.beginPath();
        this.ctx.arc(mouseX, mouseY, PREVIEW_RADIUS, 0, 2 * Math.PI);
        this.ctx.strokeStyle = BORDER_COLOR;
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash(PREVIEW_DASH_PATTERN);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
    }

    /**
     * Draw complete polygon with vertices
     * @param {Array<{x: number, y: number}>} vertices - Polygon vertices
     */
    drawCompletePolygon(vertices) {
        this.clear();
        if (vertices.length === 0) return;

        this.drawPolygonPath(vertices, true);
        this.drawVertices(vertices);
    }

    /**
     * Draw polygon with preview line to mouse
     * @param {Array<{x: number, y: number}>} vertices - Polygon vertices
     * @param {number} mouseX - Mouse X position
     * @param {number} mouseY - Mouse Y position
     */
    drawPolygonWithPreview(vertices, mouseX, mouseY) {
        this.clear();
        if (vertices.length === 0) return;

        this.drawPreviewLine(vertices, mouseX, mouseY);
        this.drawVertices(vertices);
    }
}

// ============================================================================
// Main ClassifyAnnotator Class
// ============================================================================

function ClassifyAnnotator(lidar, view, config) {
    // Core references
    this.lidar = lidar;
    this.view = view;
    this.config = config;

    // Event management
    this.eventHandlers = [];

    // State management
    this.isActive = false;
    this.isSelectPointsMode = false;
    this.selectedIndices = new Set();
    this.selectionHistory = [];

    // Three.js objects
    this.selectionMesh = null;
    this.overlayCanvas = null;
    this.canvasRenderer = null;

    // Reusable THREE objects for performance
    this._tempVector = new THREE.Vector3();
    this._tempMatrix = new THREE.Matrix4();

    // Polygon selection state
    this.polygonPoints = [];
    this.polygonPoints3D = [];
    this.polygonPointIndices = [];  // Indices of snapped points (in filtered geometry)
    this.isDrawingPolygon = false;
    this.polygonCompleted = false;

    // Configuration
    this.classifyConfig = null;
    this.configLoadPromise = null;
    this.selectionColor = new THREE.Color(1.0, 1.0, 0.0);

    // UI State Manager (shared across instances / frame switches)
    this.uiStateManager = sharedUIStateManager;

    // Camera change tracking
    this._lastCameraMatrix = null;
    this._cameraCheckId = null;

    this.init();
}

// ============================================================================
// Initialization Methods
// ============================================================================

ClassifyAnnotator.prototype.init = async function() {
    // Deactivate existing annotator (don't call cleanup - that destroys event listeners)
    const existingAnnotator = ClassifyAnnotatorRegistry.activeAnnotators.get(this.view.container);
    if (existingAnnotator && existingAnnotator !== this) {
        Logger.log('Deactivating existing ClassifyAnnotator for this view, frame:', existingAnnotator.lidar?.frameInfo?.frame);
        existingAnnotator.isActive = false;
        if (existingAnnotator.overlayCanvas) {
            existingAnnotator.overlayCanvas.style.display = 'none';
        }
    }

    // Load config
    await this.loadConfig();

    // Setup UI
    this.createOverlayCanvas();
    // Bind the classify panel's shared buttons only once (across all instances)
    // to prevent duplicate handler invocations after frame switches.
    bindClassifyGlobalUIOnce();
    this.bindEvents();
    this.startCameraChangeListener();

    // Sync with checkbox state
    this.syncWithCheckboxState();

    Logger.log('ClassifyAnnotator initialized');
};

ClassifyAnnotator.prototype.syncWithCheckboxState = async function() {
    const modeCheckbox = document.getElementById('cfg-classify-mode-checkbox');
    const selectPointsCheckbox = document.getElementById('classify-select-points');

    if (modeCheckbox && modeCheckbox.checked) {
        Logger.log('Syncing with checkbox state (active)');

        this.isActive = true;
        ClassifyAnnotatorRegistry.setActive(this.view.container, this);

        // Show panel and overlay
        this.showUIElements();

        // Initialize the annotation state from the values saved in the PCD
        await this.initClassifyState();

        // Apply Classify Mode UI settings
        this.uiStateManager.save();
        this.uiStateManager.applyClassifyModeSettings();
        this.refreshPointCloud();

        // Sync select points mode
        if (selectPointsCheckbox && selectPointsCheckbox.checked) {
            this.isSelectPointsMode = true;
        }
    }
};

ClassifyAnnotator.prototype.showUIElements = function() {
    const classifyPanel = document.getElementById('classify-panel');
    if (classifyPanel) {
        classifyPanel.style.display = 'block';
    }

    if (this.overlayCanvas) {
        this.overlayCanvas.style.display = 'block';
    }
};

ClassifyAnnotator.prototype.loadConfig = async function() {
    if (this.classifyConfig) return;
    if (this.configLoadPromise) return this.configLoadPromise;

    this.configLoadPromise = (async () => {
        try {
            const response = await fetch('/static/classify_config.json');
            this.classifyConfig = await response.json();

            // Set selection color
            if (this.classifyConfig.selection_settings) {
                const color = this.classifyConfig.selection_settings.selection_color;
                this.selectionColor.setRGB(color[0], color[1], color[2]);
            }

            // Expose classify class -> RGB color map globally so lidar.color_points 可复用
            if (Array.isArray(this.classifyConfig.classify_classes)) {
                const classMap = {};
                this.classifyConfig.classify_classes.forEach(cls => {
                    if (Array.isArray(cls.color) && cls.color.length >= 3) {
                        classMap[cls.value] = [cls.color[0], cls.color[1], cls.color[2]];
                    }
                });
                window.classifyClassMap = classMap;
            }

            // 渲染 classify 类别单选按钮到面板
            this.renderClassList();
        } catch (e) {

            Logger.warn('Failed to load config, using defaults:', e);
        } finally {
            this.configLoadPromise = null;
        }
    })();


    return this.configLoadPromise;
};

// ============================================================================
// Class List Rendering
// ============================================================================

/**
 * 根据 classify_config.json 中的 classify_classes，把每个类别渲染成一个
 * 单选按钮 (name="classify-value")，插入 #classify-class-list 里。
 */
ClassifyAnnotator.prototype.renderClassList = function() {
    const listEl = document.getElementById('classify-class-list');
    if (!listEl || !this.classifyConfig || !Array.isArray(this.classifyConfig.classify_classes)) {
        return;
    }

    // 已经渲染过（可能是上一个 world 的实例填的）就不重复了
    if (listEl.querySelector('input[name="classify-value"]')) {
        return;
    }

    const defaultVal = (typeof this.classifyConfig.default_classify === 'number')
        ? this.classifyConfig.default_classify
        : (this.classifyConfig.classify_classes[0] && this.classifyConfig.classify_classes[0].value);

    const frag = document.createDocumentFragment();
    this.classifyConfig.classify_classes.forEach(cls => {
        const label = document.createElement('label');
        label.className = 'classify-class-item';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'classify-value';
        radio.value = String(cls.value);
        if (cls.value === defaultVal) radio.checked = true;

        const swatch = document.createElement('span');
        swatch.className = 'classify-color-swatch';
        if (Array.isArray(cls.color) && cls.color.length >= 3) {
            const r = Math.round(cls.color[0] * 255);
            const g = Math.round(cls.color[1] * 255);
            const b = Math.round(cls.color[2] * 255);
            swatch.style.background = `rgb(${r},${g},${b})`;
        }

        const text = document.createElement('span');
        text.className = 'classify-class-name';
        text.textContent = `${cls.value} - ${cls.name || ''}`;

        label.appendChild(radio);
        label.appendChild(swatch);
        label.appendChild(text);
        frag.appendChild(label);
    });

    listEl.innerHTML = '';
    listEl.appendChild(frag);
};

// ============================================================================
// Canvas Management
// ============================================================================

ClassifyAnnotator.prototype.createOverlayCanvas = function() {

    // Remove existing canvases
    const existingCanvases = this.view.container.querySelectorAll('canvas.classify-overlay-canvas');
    existingCanvases.forEach(canvas => canvas.remove());

    // Create new canvas
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'classify-overlay-canvas';
    Object.assign(this.overlayCanvas.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        pointerEvents: 'none',
        zIndex: '1000',
        display: 'none'
    });

    this.view.container.appendChild(this.overlayCanvas);
    this.updateCanvasSize();

    // Create renderer
    this.canvasRenderer = new CanvasOverlayRenderer(this.overlayCanvas);

    // Resize handler
    this.addEvent(window, 'resize', () => this.updateCanvasSize());
};

ClassifyAnnotator.prototype.updateCanvasSize = function() {
    if (this.overlayCanvas && this.view.container) {
        this.overlayCanvas.width = this.view.container.clientWidth;
        this.overlayCanvas.height = this.view.container.clientHeight;
        // Update canvas renderer context after resize
        if (this.canvasRenderer) {
            this.canvasRenderer.updateCanvas(this.overlayCanvas);
        }
    }
};

// ============================================================================
// Event Binding
// ============================================================================

ClassifyAnnotator.prototype.bindEvents = function() {
    // NOTE: Global Classify-panel button bindings (Undo / Clear / Save / Apply /
    // Close / master checkbox / select-points) are now bound ONCE at module
    // scope via bindClassifyGlobalUIOnce(). Do NOT re-bind them here — doing so
    // would accumulate duplicate listeners across frame switches and cause
    // dialogs to appear repeatedly (the user reported being "stuck" in popup
    // dialogs because a single click was invoking N prior handlers).
    //
    // Mouse/keyboard listeners on the 3D view container and document are kept
    // per-instance because their handlers early-return when !this.isActive,
    // so stale instances become inert no-ops.

    // Mouse events (capture phase)
    this.addEvent(this.view.container, 'mousedown', (e) => this.onMouseDown(e), true);
    this.addEvent(this.view.container, 'mousemove', (e) => this.onMouseMove(e), true);
    this.addEvent(this.view.container, 'mouseup', (e) => this.onMouseUp(e), true);
    this.addEvent(this.view.container, 'dblclick', (e) => this.onDoubleClick(e), true);

    // Keyboard
    this.addEvent(document, 'keydown', (e) => this.onKeyDown(e));

    // Panel dragging (uses per-instance addEvent so header listener is
    // deduplicated implicitly: bindClassifyGlobalUIOnce handles the buttons,
    // but header drag needs a reference to the panel DOM which is stable, so
    // we also guard it with a module-level flag).
    setupClassifyPanelDraggingOnce();
};

ClassifyAnnotator.prototype.bindUIElement = function(id, event, handler) {
    const element = document.getElementById(id);
    if (element) {
        this.addEvent(element, event, handler);
    }
};

ClassifyAnnotator.prototype.addEvent = function(element, event, handler, options = false) {
    element.addEventListener(event, handler, options);
    this.eventHandlers.push({ element, event, handler, options });
};

// ============================================================================
// Camera Change Listener
// ============================================================================

ClassifyAnnotator.prototype.startCameraChangeListener = function() {
    const checkCameraChange = () => {
        if (!this.isActive || this.polygonPoints3D.length === 0) {
            this._cameraCheckId = requestAnimationFrame(checkCameraChange);
            return;
        }

        const currentMatrix = this.view.camera.matrixWorld.elements;

        if (!this._lastCameraMatrix || this.hasMatrixChanged(currentMatrix, this._lastCameraMatrix)) {
            this.updatePolygonFrom3D();
            this._lastCameraMatrix = currentMatrix.slice();
        }

        this._cameraCheckId = requestAnimationFrame(checkCameraChange);
    };

    this._cameraCheckId = requestAnimationFrame(checkCameraChange);
};

ClassifyAnnotator.prototype.hasMatrixChanged = function(current, last, threshold = 0.0001) {
    for (let i = 0; i < 16; i++) {
        if (Math.abs(current[i] - last[i]) > threshold) {
            return true;
        }
    }
    return false;
};

ClassifyAnnotator.prototype.stopCameraChangeListener = function() {
    if (this._cameraCheckId) {
        cancelAnimationFrame(this._cameraCheckId);
        this._cameraCheckId = null;
    }
};

// ============================================================================
// Classify State Initialization
// ============================================================================

/**
 * Initialize the Classify Mode working state from the point cloud's *saved*
 * classify values, i.e. the values that currently live in the PCD file on disk.
 *
 * `pcd.srcClassify` is the untouched, POINTS-length snapshot the loader took
 * straight from the file, while `pcd.classify` is the working copy that
 * applyClassify()/undo()/clear() mutate in place. Re-seeding the working copy
 * from the snapshot means entering the mode always starts from what is on disk,
 * discarding edits that were never saved (e.g. edited, exited the mode, came
 * back). `lidar.color_points()` colors straight from `pcd.classify`, so
 * recoloring after the re-seed renders the saved classes immediately.
 *
 * Every PCD of this project carries a U1 `classify` field, so no missing-field
 * or type fallbacks are handled here.
 */
ClassifyAnnotator.prototype.initClassifyState = async function() {
    await this.loadConfig();

    if (!this.lidar?.points || !this.lidar.pcd) {
        Logger.warn('No point cloud available; cannot init classify state');
        return;
    }

    const pcd = this.lidar.pcd;
    const numPoints = this.lidar.points.geometry.attributes.position.count;

    // Re-seed the working copy from the file snapshot, mapping file rows back to
    // the kept points (PCDLoader drops NaN/origin points, the z-range filter
    // drops more, and both keep `srcIndex` aligned with `classify`).
    for (let i = 0; i < numPoints; i++) {
        pcd.classify[i] = pcd.srcClassify[pcd.srcIndex[i]] & 0xff;
    }

    // Undo history belongs to a single mode session: entries taken before the
    // state was re-seeded would restore values the user can no longer see.
    this.selectionHistory = [];

    Logger.log(`Initialized classify state from saved PCD values (${numPoints} points)`);
};

// ============================================================================
// Mode Management
// ============================================================================

ClassifyAnnotator.prototype.setActive = async function(active) {
    Logger.log('setActive called, active:', active);
    Logger.log('  - this.lidar.frame:', this.lidar?.frameInfo?.frame);

    this.isActive = active;

    // Registry management
    if (active) {
        ClassifyAnnotatorRegistry.setActive(this.view.container, this);
    } else {
        ClassifyAnnotatorRegistry.remove(this.view.container);
    }

    // UI panel
    const classifyPanel = document.getElementById('classify-panel');
    if (classifyPanel) {
        classifyPanel.style.display = active ? 'block' : 'none';
    }

    // Classify state
    if (active) {
        // Requirement: entering the mode always starts from the classify values
        // saved in the PCD file, which become the initial annotation state.
        await this.initClassifyState();
        this.uiStateManager.save();
        this.uiStateManager.applyClassifyModeSettings();
    } else {
        this.uiStateManager.restore();
        this.setSelectPointsMode(false);
    }

    this.refreshPointCloud();

    // Overlay canvas
    if (active) {
        if (!this.overlayCanvas) {
            this.createOverlayCanvas();
        } else if (this.canvasRenderer) {
            // Ensure canvas renderer context is valid
            this.canvasRenderer.updateCanvas(this.overlayCanvas);
        }
        this.overlayCanvas.style.display = 'block';
    } else {
        if (this.overlayCanvas) {
            this.overlayCanvas.style.display = 'none';
        }
        this.clearSelection();
    }
};

ClassifyAnnotator.prototype.setSelectPointsMode = function(active) {
    this.isSelectPointsMode = active;

    if (active) {
        this.view.container.style.cursor = 'crosshair';
        this.polygonPoints = [];
        this.polygonPoints3D = [];
        this.polygonPointIndices = [];
        this.polygonCompleted = false;
        // Ensure canvas renderer is properly initialized
        if (this.overlayCanvas && this.canvasRenderer) {
            this.canvasRenderer.updateCanvas(this.overlayCanvas);
        }
        this.clearOverlay();
    } else {
        this.view.container.style.cursor = 'default';
        if (!this.polygonCompleted) {
            this.polygonPoints = [];
            this.polygonPoints3D = [];
            this.polygonPointIndices = [];
            this.clearOverlay();
        }
    }
};

// ============================================================================
// State Reset & Cleanup
// ============================================================================

ClassifyAnnotator.prototype.resetState = async function() {
    Logger.log('resetState called, frame:', this.lidar?.frameInfo?.frame);

    // Clear selection
    this.selectedIndices.clear();
    this.polygonPoints = [];
    this.polygonPoints3D = [];
    this.polygonPointIndices = [];
    this.isDrawingPolygon = false;
    this.polygonCompleted = false;

    // Remove highlight mesh
    this.disposeSelectionMesh();
    this.clearOverlay();
    this.updateSelectedCount();

    // Sync mode
    const selectPointsCheckbox = document.getElementById('classify-select-points');
    if (selectPointsCheckbox) {
        this.isSelectPointsMode = selectPointsCheckbox.checked;
    }

    // Check if should be active
    const modeCheckbox = document.getElementById('cfg-classify-mode-checkbox');
    const shouldBeActive = modeCheckbox?.checked;

    if (shouldBeActive && this.lidar?.points) {
        this.isActive = true;
        ClassifyAnnotatorRegistry.setActive(this.view.container, this);

        // Recreate overlay canvas for correct container attachment
        if (this.overlayCanvas && this.overlayCanvas.parentNode) {
            this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
        }
        this.overlayCanvas = null;
        this.canvasRenderer = null;
        this.createOverlayCanvas();
        this.overlayCanvas.style.display = 'block';
        await this.initClassifyState();
    } else {
        this.isActive = false;
    }
};

ClassifyAnnotator.prototype.cleanup = function() {
    Logger.log('Cleaning up, frame:', this.lidar?.frameInfo?.frame);

    // Remove event listeners
    this.eventHandlers.forEach(({ element, event, handler, options }) => {
        element.removeEventListener(event, handler, options);
    });
    this.eventHandlers = [];

    // Stop camera listener
    this.stopCameraChangeListener();

    // Remove overlay canvas
    if (this.overlayCanvas?.parentNode) {
        this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
        this.overlayCanvas = null;
        this.canvasRenderer = null;
    }

    // Dispose selection mesh
    this.disposeSelectionMesh();

    // Reset state
    this.isActive = false;
    this.isSelectPointsMode = false;
    this.selectedIndices.clear();
    this.polygonPoints = [];
    this.polygonPoints3D = [];
    this.polygonPointIndices = [];
    this.isDrawingPolygon = false;
    this.polygonCompleted = false;

    this.updateSelectedCount();
};

ClassifyAnnotator.prototype.disposeSelectionMesh = function() {
    if (this.selectionMesh) {
        this.view.scene.remove(this.selectionMesh);
        this.selectionMesh.geometry.dispose();
        this.selectionMesh.material?.dispose();
        this.selectionMesh = null;
    }
};

// ============================================================================
// Mouse Event Handlers
// ============================================================================

ClassifyAnnotator.prototype.onMouseDown = function(event) {
    if (!this.isActive || event.button !== 0 || !this.isSelectPointsMode) return;

    event.stopPropagation();
    event.preventDefault();

    const rect = this.view.container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    const snappedPoint = this.snapToNearestPoint(mouseX, mouseY);

    // Clear previous polygon if starting new
    if (!this.isDrawingPolygon && this.polygonPoints.length > 0) {
        this.polygonPoints = [];
        this.polygonPoints3D = [];
        this.polygonPointIndices = [];
        this.clearSelection();
        this.polygonCompleted = false;
    }

    this.polygonPoints.push({ x: snappedPoint.screenX, y: snappedPoint.screenY });
    if (snappedPoint.worldPos) {
        this.polygonPoints3D.push(snappedPoint.worldPos.clone());
    }
    // Save the snapped point index (even if null, to keep arrays in sync)
    this.polygonPointIndices.push(snappedPoint.pointIndex);
    this.isDrawingPolygon = true;

    this.drawPolygon();
};

ClassifyAnnotator.prototype.onMouseMove = function(event) {
    if (!this.isActive || !this.isSelectPointsMode || !this.isDrawingPolygon) return;

    event.stopPropagation();
    event.preventDefault();

    const rect = this.view.container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    this.drawPolygonWithPreview(x, y);
};

ClassifyAnnotator.prototype.onMouseUp = function(event) {
    if (!this.isActive || event.button !== 0 || !this.isSelectPointsMode) return;

    event.stopPropagation();
    event.preventDefault();
};

ClassifyAnnotator.prototype.onDoubleClick = function(event) {
    if (!this.isActive || !this.isSelectPointsMode || event.button !== 0) return;

    event.stopPropagation();
    event.preventDefault();

    if (this.polygonPoints.length >= 3) {
        this.selectPointsInPolygon();
        this.isDrawingPolygon = false;
        this.polygonCompleted = true;
        this.drawPolygon();

        // Auto-uncheck select points
        const checkbox = document.getElementById('classify-select-points');
        if (checkbox?.checked) {
            checkbox.checked = false;
            this.setSelectPointsMode(false);
        }
    }
};

ClassifyAnnotator.prototype.onKeyDown = function(event) {
    if (!this.isActive) return;

    if (event.key === 'Escape') {
        this.clearSelection();
    } else if (event.key === 'z' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.undo();
    }
};

// ============================================================================
// Drawing Methods
// ============================================================================

ClassifyAnnotator.prototype.clearOverlay = function() {
    if (!this.overlayCanvas || !this.canvasRenderer) return;
    // Ensure context is valid before clearing
    if (!this.canvasRenderer.ctx) {
        this.canvasRenderer.updateCanvas(this.overlayCanvas);
    }
    this.canvasRenderer.clear();
};

ClassifyAnnotator.prototype.drawPolygon = function() {
    if (!this.overlayCanvas || !this.canvasRenderer) return;
    // Ensure context is valid before drawing
    if (!this.canvasRenderer.ctx) {
        this.canvasRenderer.updateCanvas(this.overlayCanvas);
    }
    this.canvasRenderer.drawCompletePolygon(this.polygonPoints);
};

ClassifyAnnotator.prototype.drawPolygonWithPreview = function(mouseX, mouseY) {
    if (!this.overlayCanvas || !this.canvasRenderer) return;
    // Ensure context is valid before drawing
    if (!this.canvasRenderer.ctx) {
        this.canvasRenderer.updateCanvas(this.overlayCanvas);
    }
    this.canvasRenderer.drawPolygonWithPreview(this.polygonPoints, mouseX, mouseY);
};

// ============================================================================
// Point Selection Methods
// ============================================================================

ClassifyAnnotator.prototype.selectPointsInPolygon = function() {
    if (!this.lidar?.points || this.polygonPoints3D.length < 3) return;

    const positions = this.lidar.points.geometry.attributes.position.array;
    const matrixWorld = this.lidar.points.matrixWorld;

    Logger.log('selectPointsInPolygon called');
    Logger.log('  - Geometry has', positions.length / 3, 'points');
    Logger.log('  - Polygon has', this.polygonPoints3D.length, 'vertices');

    // First, add all snapped vertex points to selection
    let snappedCount = 0;
    for (const idx of this.polygonPointIndices) {
        if (idx !== null && idx !== undefined) {
            this.selectedIndices.add(idx);
            snappedCount++;
        }
    }
    Logger.log('  - Added', snappedCount, 'snapped vertex points');

    // Project to 2D (X-Y plane)
    const polygon2D = this.polygonPoints3D.map(pos => ({ x: pos.x, y: pos.y }));

    // Check each point using reusable vector
    for (let i = 0; i < positions.length / 3; i++) {
        const idx = i * 3;
        this._tempVector.set(positions[idx], positions[idx + 1], positions[idx + 2]);
        this._tempVector.applyMatrix4(matrixWorld);

        if (isPointInPolygon(this._tempVector.x, this._tempVector.y, polygon2D)) {
            this.selectedIndices.add(i);
        }
    }

    Logger.log('  - Selected', this.selectedIndices.size, 'points total');
    this.updateSelectedCount();
    this.highlightSelectedPoints();
};

ClassifyAnnotator.prototype.snapToNearestPoint = function(screenX, screenY) {
    const defaultResult = { screenX, screenY, worldPos: null, pointIndex: null };

    if (!this.lidar?.points || !this.overlayCanvas) return defaultResult;

    const positions = this.lidar.points.geometry.attributes.position.array;
    const camera = this.view.camera;
    const matrixWorld = this.lidar.points.matrixWorld;
    const maxRadius = CONFIG.SNAPPING.MAX_RADIUS_PX;
    const canvasWidth = this.overlayCanvas.width;
    const canvasHeight = this.overlayCanvas.height;

    let nearestDist = Infinity;
    let nearestScreenX = screenX;
    let nearestScreenY = screenY;
    let nearestWorldPos = null;
    let nearestPointIndex = null;

    for (let i = 0; i < positions.length / 3; i++) {
        const idx = i * 3;

        // Use reusable vector
        this._tempVector.set(positions[idx], positions[idx + 1], positions[idx + 2]);
        this._tempVector.applyMatrix4(matrixWorld);
        this._tempVector.project(camera);

        // Skip if behind camera
        if (this._tempVector.z >= 1) continue;

        const px = (this._tempVector.x + 1) / 2 * canvasWidth;
        const py = (-this._tempVector.y + 1) / 2 * canvasHeight;
        const dist = Math.sqrt((px - screenX) ** 2 + (py - screenY) ** 2);

        if (dist < maxRadius && dist < nearestDist) {
            nearestDist = dist;
            nearestScreenX = px;
            nearestScreenY = py;
            nearestPointIndex = i;
            // Store world position
            this._tempVector.set(positions[idx], positions[idx + 1], positions[idx + 2]);
            this._tempVector.applyMatrix4(matrixWorld);
            nearestWorldPos = this._tempVector.clone();
        }
    }

    Logger.log(`Snapped: distance=${nearestDist.toFixed(1)}px, pointIndex=${nearestPointIndex}`);

    return { screenX: nearestScreenX, screenY: nearestScreenY, worldPos: nearestWorldPos, pointIndex: nearestPointIndex };
};

ClassifyAnnotator.prototype.updatePolygonFrom3D = function() {
    if (this.polygonPoints3D.length === 0 || !this.overlayCanvas) return;

    const camera = this.view.camera;
    const canvasWidth = this.overlayCanvas.width;
    const canvasHeight = this.overlayCanvas.height;

    this.polygonPoints = this.polygonPoints3D.map(worldPos => {
        const screenPos = worldPos.clone().project(camera);
        return {
            x: (screenPos.x + 1) / 2 * canvasWidth,
            y: (-screenPos.y + 1) / 2 * canvasHeight
        };
    });

    if (this.polygonPoints.length > 0) {
        this.drawPolygon();
    }
};

// ============================================================================
// Visualization Methods
// ============================================================================

ClassifyAnnotator.prototype.highlightSelectedPoints = function() {
    this.disposeSelectionMesh();

    if (this.selectedIndices.size === 0) return;

    Logger.log(`Highlighting ${this.selectedIndices.size} points`);

    const positions = [];
    const colors = [];
    const originalPositions = this.lidar.points.geometry.attributes.position.array;

    Logger.log('  - Filtered geometry positions array length:', originalPositions.length);
    Logger.log('  - Number of points in filtered geometry:', originalPositions.length / 3);

    // Log first few selected positions for debugging
    const sampleIndices = Array.from(this.selectedIndices).slice(0, 3);
    for (const idx of sampleIndices) {
        const i = idx * 3;
        Logger.log(`  - Highlighting filtered index ${idx}: pos=(${originalPositions[i].toFixed(2)}, ${originalPositions[i+1].toFixed(2)}, ${originalPositions[i+2].toFixed(2)})`);
    }

    for (const idx of this.selectedIndices) {
        const i = idx * 3;
        positions.push(originalPositions[i], originalPositions[i + 1], originalPositions[i + 2]);
        colors.push(1.0, 1.0, 0.0); // Yellow
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: this.config.point_size * CONFIG.HIGHLIGHT.SIZE_MULTIPLIER,
        vertexColors: true,
        sizeAttenuation: false,
        transparent: false,
        opacity: 1.0,
        depthTest: false
    });

    this.selectionMesh = new THREE.Points(geometry, material);
    this.selectionMesh.matrixAutoUpdate = false;
    this.selectionMesh.matrix.copy(this.lidar.points.matrixWorld);
    this.selectionMesh.renderOrder = CONFIG.HIGHLIGHT.RENDER_ORDER;

    this.view.scene.add(this.selectionMesh);
};

ClassifyAnnotator.prototype.updateSelectedCount = function() {
    const countEl = document.getElementById('classify-selected-count');
    if (countEl) {
        countEl.textContent = this.selectedIndices.size;
    }
};

// ============================================================================
// Classification Operations
// ============================================================================

ClassifyAnnotator.prototype.applyClassify = function(classifyValue) {
    if (this.selectedIndices.size === 0) {
        Logger.warn('No points selected');
        return;
    }

    this.saveToHistory();
    const count = this.selectedIndices.size;

    Logger.log('applyClassify called with value:', classifyValue, ', count:', count);

    for (const idx of this.selectedIndices) {
        if (idx >= 0 && idx < this.lidar.pcd.classify.length) {
            this.lidar.pcd.classify[idx] = classifyValue;
        }
    }

    this.refreshPointCloud();
    this.clearPolygonAndSelection();

    Logger.log(`Applied classify ${classifyValue} to ${count} points`);
};

ClassifyAnnotator.prototype.clearAllClassifications = function() {
    this.showConfirm('确定要清除所有分类标注吗？所有未保存的分类将被重置为"未分类"状态。', () => {
        this.saveAllToHistory();

        let changedCount = 0;
        for (let i = 0; i < this.lidar.pcd.classify.length; i++) {
            if (this.lidar.pcd.classify[i] !== 0) {
                this.lidar.pcd.classify[i] = 0;
                changedCount++;
            }
        }

        this.refreshPointCloud();
        this.clearPolygonAndSelection();

        Logger.log(`Cleared ${changedCount} classifications`);
        this.showToast(`已清除 ${changedCount} 个分类标注`, 'success');
    });
};

// ============================================================================
// History Management
// ============================================================================

ClassifyAnnotator.prototype.saveToHistory = function() {
    if (this.selectedIndices.size === 0) return;

    const snapshot = new Map();
    for (const idx of this.selectedIndices) {
        if (idx >= 0 && idx < this.lidar.pcd.classify.length) {
            snapshot.set(idx, this.lidar.pcd.classify[idx]);
        }
    }

    this.selectionHistory.push(snapshot);
    this.trimHistory();
};

ClassifyAnnotator.prototype.saveAllToHistory = function() {
    const snapshot = new Map();
    for (let i = 0; i < this.lidar.pcd.classify.length; i++) {
        snapshot.set(i, this.lidar.pcd.classify[i]);
    }

    this.selectionHistory.push(snapshot);
    this.trimHistory();
};

ClassifyAnnotator.prototype.trimHistory = function() {
    while (this.selectionHistory.length > CONFIG.HISTORY.MAX_SIZE) {
        this.selectionHistory.shift();
    }
};

ClassifyAnnotator.prototype.undo = function() {
    if (this.selectionHistory.length === 0) {
        Logger.warn('Nothing to undo');
        this.showToast('没有可撤销的操作', 'warn');
        return;
    }

    const snapshot = this.selectionHistory.pop();

    for (const [idx, value] of snapshot) {
        if (idx >= 0 && idx < this.lidar.pcd.classify.length) {
            this.lidar.pcd.classify[idx] = value;
        }
    }

    this.refreshPointCloud();
    Logger.log('Undo performed');
    this.showToast('已撤销上一步操作', 'success');
};

// ============================================================================
// Selection Management
// ============================================================================

ClassifyAnnotator.prototype.clearSelection = function() {
    this.selectedIndices.clear();
    this.updateSelectedCount();
    this.highlightSelectedPoints();
};

ClassifyAnnotator.prototype.selectAllPoints = function() {
    if (!this.lidar?.points) {
        Logger.warn('selectAllPoints: no lidar points available');
        return;
    }

    const posAttr = this.lidar.points.geometry.attributes.position;
    if (!posAttr) {
        Logger.warn('selectAllPoints: no position attribute');
        return;
    }

    const total = posAttr.count; // number of points in current filtered geometry

    // Reset any polygon-drawing state so the yellow highlight owns the frame,
    // matching the visual outcome of a completed polygon selection.
    this.selectedIndices.clear();
    this.polygonPoints = [];
    this.polygonPoints3D = [];
    this.polygonPointIndices = [];
    this.isDrawingPolygon = false;
    this.polygonCompleted = false;
    this.clearOverlay();

    for (let i = 0; i < total; i++) {
        this.selectedIndices.add(i);
    }

    // Turning off select-points mode mirrors the auto-uncheck that runs after
    // a polygon is closed, so the user can immediately click a class + 应用.
    const checkbox = document.getElementById('classify-select-points');
    if (checkbox?.checked) {
        checkbox.checked = false;
        this.setSelectPointsMode(false);
    }

    Logger.log(`selectAllPoints: selected ${total} points`);
    this.updateSelectedCount();
    this.highlightSelectedPoints();
};

ClassifyAnnotator.prototype.clearPolygonAndSelection = function() {
    this.selectedIndices.clear();
    this.updateSelectedCount();
    this.disposeSelectionMesh();

    this.polygonPoints = [];
    this.polygonPoints3D = [];
    this.polygonPointIndices = [];
    this.isDrawingPolygon = false;
    this.polygonCompleted = false;

    this.clearOverlay();
};

// ============================================================================
// Utility Methods
// ============================================================================

ClassifyAnnotator.prototype.refreshPointCloud = function() {
    if (!this.lidar?.points) return;

    // color_points() reads pcd.classify and writes the geometry color attribute.
    this.lidar.color_points();
    this.lidar.update_points_color();

    if (this.view.renderer && this.view.scene) {
        this.view.renderer.render(this.view.scene, this.view.camera);
    }
};

// ============================================================================
// Panel Dragging
// ============================================================================

ClassifyAnnotator.prototype.setupPanelDragging = function() {
    const panel = document.getElementById('classify-panel');
    const header = document.getElementById('classify-panel-header');

    if (!panel || !header) return;

    let isDragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    const onMouseDown = (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = panel.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        header.style.cursor = 'grabbing';
        e.preventDefault();
    };

    const onMouseMove = (e) => {
        if (!isDragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const maxLeft = window.innerWidth - panel.offsetWidth;
        const maxTop = window.innerHeight - panel.offsetHeight;

        panel.style.left = Math.max(0, Math.min(startLeft + dx, maxLeft)) + 'px';
        panel.style.top = Math.max(0, Math.min(startTop + dy, maxTop)) + 'px';
        panel.style.right = 'auto';
    };

    const onMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'move';
        }
    };

    this.addEvent(header, 'mousedown', onMouseDown);
    this.addEvent(document, 'mousemove', onMouseMove);
    this.addEvent(document, 'mouseup', onMouseUp);
};

// ============================================================================
// Save to PCD
// ============================================================================

ClassifyAnnotator.prototype.saveToPCD = function() {
    if (!this.lidar.pcd) {
        Logger.warn('No PCD data to save');
        return;
    }

    const pcd = this.lidar.pcd;

    // PCDLoader drops invalid points (NaN / all-zero coordinates) and the
    // optional z-range filter drops more, so pcd.classify only covers the
    // points kept in the viewer. The backend needs one value per row of the
    // original file (POINTS in the PCD header). Scatter the edited values back
    // to their original row index, keeping the file's original value for any
    // point that was filtered out.
    const full = new Uint8Array(pcd.srcPointCount);
    for (let i = 0; i < pcd.srcPointCount; i++) {
        full[i] = pcd.srcClassify[i] & 0xff;
    }
    const n = Math.min(pcd.srcIndex.length, pcd.classify.length);
    for (let i = 0; i < n; i++) {
        const si = pcd.srcIndex[i];
        if (si >= 0 && si < pcd.srcPointCount) {
            full[si] = pcd.classify[i] & 0xff;
        }
    }
    const classify = Array.from(full);
    Logger.log(`saveToPCD: expanded ${n} kept points to ${pcd.srcPointCount} file rows`);

    const data = {
        scene: this.lidar.frameInfo.scene,
        frame: this.lidar.frameInfo.frame,
        classify: classify,
        timestamp: new Date().toISOString()
    };

    fetch('/save_classify_pcd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(response => response.json())
    .then(result => {
        if (result.status === 'ok') {
            // The file on disk now holds these values, so they become the saved
            // baseline that re-entering Classify Mode initializes from.
            for (let i = 0; i < pcd.srcPointCount; i++) {
                pcd.srcClassify[i] = full[i];
            }
            Logger.log('Saved successfully');
            this.showAlert('分类标注已保存到PCD文件', 'success', '保存成功');
        } else {
            Logger.error('Save failed:', result.error);
            this.showAlert('保存失败: ' + (result.error || '未知错误'), 'error', '保存失败');
        }
    })
    .catch(error => {
        Logger.error('Save error:', error);
        this.showAlert('保存出错: ' + error.message, 'error', '保存出错');
    });
};

// ============================================================================
// Custom In-Page Dialog Helpers
//
// Replaces browser-native alert()/confirm() which can be unreliable in some
// embedded/webview contexts (e.g. after multiple rapid dialog dismissals the
// browser may suppress subsequent dialogs, or the OK button may not properly
// return focus to the page). These helpers render a fully controlled overlay
// inside the app, so the OK/Cancel buttons are guaranteed to dismiss the dialog.
// ============================================================================

/**
 * Show a modal confirmation dialog with 确定/取消 buttons.
 * @param {string} message      - Message to display
 * @param {Function} onConfirm  - Callback when user clicks 确定
 * @param {Function} [onCancel] - Optional callback when user clicks 取消
 * @param {string} [title]      - Optional dialog title
 */
ClassifyAnnotator.prototype.showConfirm = function(message, onConfirm, onCancel, title) {
    this._showDialog({
        title: title || '请确认',
        message: message,
        variant: 'confirm',
        buttons: [
            {
                label: '取消',
                className: 'classify-dialog-btn-cancel',
                onClick: () => { if (typeof onCancel === 'function') onCancel(); }
            },
            {
                label: '确定',
                className: 'classify-dialog-btn-ok',
                primary: true,
                onClick: () => { if (typeof onConfirm === 'function') onConfirm(); }
            }
        ]
    });
};

/**
 * Show a modal alert dialog with a single 确定 button.
 * @param {string} message   - Message to display
 * @param {string} [variant] - 'info' | 'success' | 'warn' | 'error'
 * @param {string} [title]   - Optional dialog title
 * @param {Function} [onOk]  - Optional callback when user clicks 确定
 */
ClassifyAnnotator.prototype.showAlert = function(message, variant, title, onOk) {
    const kind = variant || 'info';
    const defaultTitle = { info: '提示', success: '成功', warn: '警告', error: '错误' }[kind] || '提示';
    this._showDialog({
        title: title || defaultTitle,
        message: message,
        variant: kind,
        buttons: [
            {
                label: '确定',
                className: 'classify-dialog-btn-ok',
                primary: true,
                onClick: () => { if (typeof onOk === 'function') onOk(); }
            }
        ]
    });
};

/**
 * Show a non-blocking toast notification that auto-dismisses.
 * @param {string} message  - Message to display
 * @param {string} [variant] - 'info' | 'success' | 'warn' | 'error'
 * @param {number} [duration] - Duration in ms (default 2500)
 */
ClassifyAnnotator.prototype.showToast = function(message, variant, duration) {
    const kind = variant || 'info';
    const timeout = typeof duration === 'number' ? duration : 2500;

    let container = document.getElementById('classify-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'classify-toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'classify-toast classify-toast-' + kind;
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => toast.classList.add('classify-toast-visible'));

    const dismiss = () => {
        toast.classList.remove('classify-toast-visible');
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 300);
    };

    setTimeout(dismiss, timeout);
    toast.addEventListener('click', dismiss);
};

/**
 * Internal: build and show a modal dialog. Ensures buttons reliably close it.
 * @private
 */
ClassifyAnnotator.prototype._showDialog = function(opts) {
    // Remove any lingering dialog (safety net so a stale one can never block clicks)
    const stale = document.getElementById('classify-dialog-overlay');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    const overlay = document.createElement('div');
    overlay.id = 'classify-dialog-overlay';
    overlay.className = 'classify-dialog-overlay';

    const box = document.createElement('div');
    box.className = 'classify-dialog-box classify-dialog-' + (opts.variant || 'info');

    const header = document.createElement('div');
    header.className = 'classify-dialog-header';
    header.textContent = opts.title || '';

    const body = document.createElement('div');
    body.className = 'classify-dialog-body';
    body.textContent = opts.message || '';

    const footer = document.createElement('div');
    footer.className = 'classify-dialog-footer';

    // Robust close routine - always removes the overlay regardless of caller errors
    const close = () => {
        try {
            document.removeEventListener('keydown', onKey, true);
        } catch (e) { /* ignore */ }
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    };

    const buttons = Array.isArray(opts.buttons) && opts.buttons.length > 0
        ? opts.buttons
        : [{ label: '确定', className: 'classify-dialog-btn-ok', primary: true }];

    buttons.forEach(btnCfg => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'classify-dialog-btn ' + (btnCfg.className || '');
        btn.textContent = btnCfg.label || 'OK';
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            close();
            if (typeof btnCfg.onClick === 'function') {
                try { btnCfg.onClick(); } catch (e) { Logger.error('Dialog button handler error:', e); }
            }
        });
        footer.appendChild(btn);
    });

    // Prevent clicks inside the box from bubbling to the overlay (which would close it)
    box.addEventListener('click', (ev) => ev.stopPropagation());
    box.addEventListener('mousedown', (ev) => ev.stopPropagation());

    // Clicking the overlay backdrop cancels the dialog (invokes last button's onClick? No -
    // to be safe, only close without invoking any callback so Confirm dialogs do not accidentally
    // trigger the confirmed action when the user clicks outside).
    overlay.addEventListener('click', () => close());

    // Escape closes the dialog without invoking any callback
    const onKey = (ev) => {
        if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            close();
        } else if (ev.key === 'Enter') {
            // Enter triggers the primary button if there is one
            const primaryCfg = buttons.find(b => b.primary);
            if (primaryCfg) {
                ev.preventDefault();
                ev.stopPropagation();
                close();
                if (typeof primaryCfg.onClick === 'function') {
                    try { primaryCfg.onClick(); } catch (e) { Logger.error('Dialog Enter handler error:', e); }
                }
            }
        }
    };
    document.addEventListener('keydown', onKey, true);

    box.appendChild(header);
    box.appendChild(body);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Focus the primary button so Enter works naturally too
    const primaryBtn = footer.querySelector('.classify-dialog-btn-ok') || footer.querySelector('button');
    if (primaryBtn) {
        setTimeout(() => primaryBtn.focus(), 0);
    }
};

export { ClassifyAnnotator };
