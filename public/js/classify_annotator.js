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

    // Default filter settings
    FILTER: {
        DEFAULT_MAX_X: 20,
        DEFAULT_MAX_Y: 20,
        DEFAULT_MIN_Z: -3.0,
        DEFAULT_MAX_Z: 5.0
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
            // Don't call cleanup() - just deactivate the previous annotator
            // cleanup destroys the annotator (removes event listeners), but
            // we want to keep the annotator intact for when we switch back to it
            Logger.log('Deactivating previous annotator for frame:', existing.lidar?.frameInfo?.frame);

            // Restore the previous annotator's geometry to its original state
            // This is important so that when we switch back to that frame later,
            // it will have the full geometry available
            if (existing.savedPointsGeometry && existing.lidar?.points) {
                Logger.log('  - Restoring geometry for previous frame, vertex count:',
                    existing.savedPointsGeometry.attributes.position.count);
                existing.lidar.points.geometry = existing.savedPointsGeometry;
                existing.lidar.points.geometry.attributes.position.needsUpdate = true;
                existing.savedPointsGeometry = null;
                existing.savedPointsMaterial = null;
            }

            existing.isActive = false;
            if (existing.overlayCanvas) {
                existing.overlayCanvas.style.display = 'none';
            }
        }
        this.activeAnnotators.set(viewContainer, annotator);
    },

    remove(viewContainer) {
        this.activeAnnotators.delete(viewContainer);
    }
};

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
    }

    /**
     * Save current UI states
     */
    save() {
        this.saveCheckbox('cfg-hide-box-checkbox', 'hideBox');
        this.saveCheckbox('cfg-hide-id-checkbox', 'hideId');
        this.saveCheckbox('cfg-hide-category-checkbox', 'hideCategory');
        this.saveColorObj();
        this.saveColorPoints();
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
        }
    }
}

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

    // UI State Manager
    this.uiStateManager = new UIStateManager();

    // Filter settings
    this.filterMaxX = CONFIG.FILTER.DEFAULT_MAX_X;
    this.filterMaxY = CONFIG.FILTER.DEFAULT_MAX_Y;
    this.filterMinZ = CONFIG.FILTER.DEFAULT_MIN_Z;
    this.filterMaxZ = CONFIG.FILTER.DEFAULT_MAX_Z;
    this.savedPointsGeometry = null;
    this.savedPointsMaterial = null;

    // Index mapping: filtered index -> original PCD index
    // This is crucial for correctly updating the original pcd.classify array
    this.originalIndexMap = null;

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

        // Restore the existing annotator's geometry to its original state
        if (existingAnnotator.savedPointsGeometry && existingAnnotator.lidar?.points) {
            Logger.log('  - Restoring geometry for existing annotator, vertex count:',
                existingAnnotator.savedPointsGeometry.attributes.position.count);
            existingAnnotator.lidar.points.geometry = existingAnnotator.savedPointsGeometry;
            existingAnnotator.lidar.points.geometry.attributes.position.needsUpdate = true;
            existingAnnotator.savedPointsGeometry = null;
            existingAnnotator.savedPointsMaterial = null;
        }

        existingAnnotator.isActive = false;
        if (existingAnnotator.overlayCanvas) {
            existingAnnotator.overlayCanvas.style.display = 'none';
        }
    }

    // Load config
    await this.loadConfig();

    // Setup UI
    this.createOverlayCanvas();
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

        // Apply filter
        await this.applyRadiusFilter();

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
            const response = await fetch('/static/config/classify_config.json');
            this.classifyConfig = await response.json();

            // Set selection color
            if (this.classifyConfig.selection_settings) {
                const color = this.classifyConfig.selection_settings.selection_color;
                this.selectionColor.setRGB(color[0], color[1], color[2]);
            }

            // Load filter settings
            if (this.classifyConfig.filter_settings) {
                const fs = this.classifyConfig.filter_settings;
                this.filterMaxX = fs.max_x || CONFIG.FILTER.DEFAULT_MAX_X;
                this.filterMaxY = fs.max_y || CONFIG.FILTER.DEFAULT_MAX_Y;
                this.filterMinZ = fs.min_z || CONFIG.FILTER.DEFAULT_MIN_Z;
                this.filterMaxZ = fs.max_z || CONFIG.FILTER.DEFAULT_MAX_Z;
                Logger.log(`Filter settings: x=[-${this.filterMaxX}, ${this.filterMaxX}], y=[-${this.filterMaxY}, ${this.filterMaxY}], z=[${this.filterMinZ}, ${this.filterMaxZ}]`);
            }
        } catch (e) {
            Logger.warn('Failed to load config, using defaults:', e);
        } finally {
            this.configLoadPromise = null;
        }
    })();

    return this.configLoadPromise;
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
    // UI element bindings
    // For the Classify Mode checkbox, only respond if THIS annotator is the active one
    this.bindUIElement('cfg-classify-mode-checkbox', 'change', (e) => {
        // Check if this annotator is the currently active one in the registry
        const activeAnnotator = ClassifyAnnotatorRegistry.activeAnnotators.get(this.view.container);
        const isThisActive = activeAnnotator === this;

        Logger.log('Checkbox changed, checked:', e.target.checked,
            ', this.frame:', this.lidar?.frameInfo?.frame,
            ', isThisActive:', isThisActive);

        // Only handle if this is the active annotator, OR if we're activating and no active annotator exists
        if (isThisActive || (e.target.checked && !activeAnnotator)) {
            this.setActive(e.target.checked);
        } else if (!e.target.checked && !isThisActive && this.isActive) {
            // If deactivating and this annotator was active (edge case), deactivate it
            this.setActive(false);
        }
    });
    this.bindUIElement('classify-select-points', 'change', (e) => this.setSelectPointsMode(e.target.checked));
    this.bindUIElement('classify-apply-btn', 'click', () => {
        const selectedRadio = document.querySelector('input[name="classify-value"]:checked');
        if (selectedRadio) this.applyClassify(parseInt(selectedRadio.value));
    });
    this.bindUIElement('classify-undo-btn', 'click', () => this.undo());
    this.bindUIElement('classify-clear-btn', 'click', () => this.clearAllClassifications());
    this.bindUIElement('classify-save-btn', 'click', () => this.saveToPCD());

    // Close button - exits Classify Mode
    this.bindUIElement('classify-close-btn', 'click', () => {
        // Uncheck the Classify Mode checkbox
        const modeCheckbox = document.getElementById('cfg-classify-mode-checkbox');
        if (modeCheckbox) {
            modeCheckbox.checked = false;
            modeCheckbox.dispatchEvent(new Event('change'));
        }
    });

    // Mouse events (capture phase)
    this.addEvent(this.view.container, 'mousedown', (e) => this.onMouseDown(e), true);
    this.addEvent(this.view.container, 'mousemove', (e) => this.onMouseMove(e), true);
    this.addEvent(this.view.container, 'mouseup', (e) => this.onMouseUp(e), true);
    this.addEvent(this.view.container, 'dblclick', (e) => this.onDoubleClick(e), true);

    // Keyboard
    this.addEvent(document, 'keydown', (e) => this.onKeyDown(e));

    // Panel dragging
    this.setupPanelDragging();
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
// Point Cloud Filtering
// ============================================================================

ClassifyAnnotator.prototype.applyRadiusFilter = async function() {
    await this.loadConfig();

    Logger.log(`applyRadiusFilter: x=[-${this.filterMaxX}, ${this.filterMaxX}], y=[-${this.filterMaxY}, ${this.filterMaxY}], z=[${this.filterMinZ}, ${this.filterMaxZ}]`);

    if (!this.lidar?.points) {
        Logger.log('No point cloud available');
        return;
    }

    const points = this.lidar.points;

    Logger.log('  - savedPointsGeometry before:', this.savedPointsGeometry ? 'exists (vertex count: ' + this.savedPointsGeometry.attributes.position.count + ')' : 'null');
    Logger.log('  - current geometry vertex count:', points.geometry.attributes.position.count);

    const originalGeometry = this.savedPointsGeometry || points.geometry;
    const positions = originalGeometry.attributes.position;

    if (!positions) return;

    // Save geometry if not already saved
    if (!this.savedPointsGeometry) {
        this.savedPointsGeometry = points.geometry;
        this.savedPointsMaterial = points.material;
        Logger.log('  - Saved current geometry for restoration');
    } else {
        Logger.log('  - Using existing saved geometry');
    }

    const posArray = positions.array;
    const numPoints = posArray.length / 3;

    // Pre-allocate arrays for better performance
    const filteredPositions = [];
    const filteredColors = [];
    const filteredIntensity = [];
    const filteredClassify = [];

    // Map: filtered index -> original index
    // This is crucial for correctly updating the original pcd.classify array
    this.originalIndexMap = [];

    const hasColor = originalGeometry.attributes.color;
    const hasIntensity = originalGeometry.attributes.intensity;
    // Note: The original geometry may NOT have a classify attribute (it's stored in this.lidar.pcd.classify)
    // We need to use this.lidar.pcd.classify as the source of truth
    const pcdClassify = this.lidar.pcd?.classify;

    // Filter points
    for (let i = 0; i < numPoints; i++) {
        const idx = i * 3;
        const x = posArray[idx];
        const y = posArray[idx + 1];
        const z = posArray[idx + 2];

        if (Math.abs(x) <= this.filterMaxX &&
            Math.abs(y) <= this.filterMaxY &&
            z >= this.filterMinZ &&
            z <= this.filterMaxZ) {

            filteredPositions.push(x, y, z);

            // Track the mapping from filtered index to original index
            this.originalIndexMap.push(i);

            if (hasColor) {
                const colorArray = hasColor.array;
                filteredColors.push(colorArray[idx], colorArray[idx + 1], colorArray[idx + 2]);
            }

            if (hasIntensity) {
                filteredIntensity.push(hasIntensity.array[i]);
            }

            // Always get classify from pcd.classify (the source of truth)
            if (pcdClassify && i < pcdClassify.length) {
                filteredClassify.push(pcdClassify[i]);
            }
        }
    }

    // Create filtered geometry
    const filteredGeometry = new THREE.BufferGeometry();
    filteredGeometry.setAttribute('position', new THREE.Float32BufferAttribute(filteredPositions, 3));

    if (filteredColors.length > 0) {
        filteredGeometry.setAttribute('color', new THREE.Float32BufferAttribute(filteredColors, 3));
    }
    if (filteredIntensity.length > 0) {
        filteredGeometry.setAttribute('intensity', new THREE.Float32BufferAttribute(filteredIntensity, 1));
    }
    // Always add classify attribute if we have classify data (critical for color_points() in Classify Mode)
    if (filteredClassify.length > 0) {
        filteredGeometry.setAttribute('classify', new THREE.Int8BufferAttribute(filteredClassify, 1));
        Logger.log(`  - Created classify attribute with ${filteredClassify.length} values`);
    }

    points.geometry = filteredGeometry;
    points.geometry.attributes.position.needsUpdate = true;

    Logger.log(`Filtered: ${filteredPositions.length / 3} points, originalIndexMap size: ${this.originalIndexMap.length}`);
};

ClassifyAnnotator.prototype.restoreRadiusFilter = function() {
    Logger.log('restoreRadiusFilter called');
    Logger.log('  - savedPointsGeometry:', this.savedPointsGeometry ? 'exists' : 'null');
    Logger.log('  - lidar.points:', this.lidar?.points ? 'exists' : 'null');

    if (!this.lidar?.points) return;

    if (this.savedPointsGeometry) {
        Logger.log('  - Restoring geometry, vertex count:', this.savedPointsGeometry.attributes.position.count);
        this.lidar.points.geometry = this.savedPointsGeometry;
        this.lidar.points.geometry.attributes.position.needsUpdate = true;
        this.savedPointsGeometry = null;
        this.savedPointsMaterial = null;

        Logger.log('Restored original point cloud');
    } else {
        Logger.log('  - No saved geometry to restore');
    }

    // Clear the index map when restoring original geometry
    this.originalIndexMap = null;
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

    // Filter
    if (active) {
        await this.applyRadiusFilter();
        this.uiStateManager.save();
        this.uiStateManager.applyClassifyModeSettings();
    } else {
        this.restoreRadiusFilter();
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
    Logger.log('resetState called');
    Logger.log('  - Current frame:', this.lidar?.frameInfo?.frame);
    Logger.log('  - savedPointsGeometry before:', this.savedPointsGeometry ? 'exists (vertex count: ' + this.savedPointsGeometry.attributes.position.count + ')' : 'null');
    Logger.log('  - Current lidar.points.geometry vertex count:', this.lidar?.points?.geometry?.attributes?.position?.count);

    // Clear selection
    this.selectedIndices.clear();
    this.polygonPoints = [];
    this.polygonPoints3D = [];
    this.polygonPointIndices = [];
    this.isDrawingPolygon = false;
    this.polygonCompleted = false;

    // Clear index map
    this.originalIndexMap = null;

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

        // Register this annotator as the active one for this view
        // This will deactivate the previous annotator (if any)
        ClassifyAnnotatorRegistry.setActive(this.view.container, this);

        // Reset saved geometry - we'll save the current (full) geometry
        this.savedPointsGeometry = null;
        this.savedPointsMaterial = null;

        // Always recreate overlay canvas when frame changes to ensure it's attached to correct container
        Logger.log('Recreating overlay canvas for frame:', this.lidar?.frameInfo?.frame);
        if (this.overlayCanvas && this.overlayCanvas.parentNode) {
            this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
        }
        this.overlayCanvas = null;
        this.canvasRenderer = null;
        this.createOverlayCanvas();
        this.overlayCanvas.style.display = 'block';
        await this.applyRadiusFilter();
        Logger.log('Applied filter, saved full geometry');
    } else {
        this.isActive = false;
    }
};

ClassifyAnnotator.prototype.cleanup = function() {
    Logger.log('Cleaning up');
    Logger.log('  - Current frame:', this.lidar?.frameInfo?.frame);
    Logger.log('  - savedPointsGeometry:', this.savedPointsGeometry ? 'exists' : 'null');

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

    // Restore point cloud geometry if we have a saved one
    // This is safe because this.lidar is THIS frame's lidar, not another frame's
    if (this.savedPointsGeometry && this.lidar?.points) {
        Logger.log('  - Restoring geometry in cleanup, vertex count:', this.savedPointsGeometry.attributes.position.count);
        this.lidar.points.geometry = this.savedPointsGeometry;
        this.lidar.points.geometry.attributes.position.needsUpdate = true;
    }
    this.savedPointsGeometry = null;
    this.savedPointsMaterial = null;

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
    Logger.log('  - Filtered geometry has', positions.length / 3, 'points');
    Logger.log('  - originalIndexMap size:', this.originalIndexMap ? this.originalIndexMap.length : 'null');
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

    // Log first few selected indices and their original indices for debugging
    if (this.selectedIndices.size > 0 && this.originalIndexMap) {
        const sampleIndices = Array.from(this.selectedIndices).slice(0, 5);
        Logger.log('  - Sample selected (filtered -> original):',
            sampleIndices.map(fi => `${fi} -> ${this.originalIndexMap[fi]}`).join(', '));
    }

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
    if (this.selectedIndices.size === 0 || !this.lidar.pcd?.classify) {
        Logger.warn('No points selected or no classify field');
        return;
    }

    this.saveToHistory();
    const count = this.selectedIndices.size;

    Logger.log('applyClassify called with value:', classifyValue);
    Logger.log('  - Selected indices count:', count);
    Logger.log('  - Selected indices (first 10):', Array.from(this.selectedIndices).slice(0, 10).join(', '));
    Logger.log('  - Original PCD classify array length:', this.lidar.pcd.classify.length);
    Logger.log('  - originalIndexMap exists:', !!this.originalIndexMap);
    if (this.originalIndexMap) {
        Logger.log('  - originalIndexMap length:', this.originalIndexMap.length);
        // Log mapping for first few selected indices
        const sampleIndices = Array.from(this.selectedIndices).slice(0, 5);
        Logger.log('  - Index mapping (filtered -> original):',
            sampleIndices.map(fi => `${fi}->${this.originalIndexMap[fi]}`).join(', '));
    }

    // Get the filtered geometry's classify attribute (if in filtered mode)
    const geometryClassify = this.lidar.points.geometry.getAttribute("classify");
    Logger.log('  - Geometry classify attribute exists:', !!geometryClassify);
    if (geometryClassify) {
        Logger.log('  - Geometry classify array length:', geometryClassify.array.length);
        // Log classify values BEFORE update for sample indices
        const sampleIndices = Array.from(this.selectedIndices).slice(0, 5);
        Logger.log('  - Classify values BEFORE:',
            sampleIndices.map(fi => `g[${fi}]=${geometryClassify.array[fi]}`).join(', '));
    }

    // Use originalIndexMap to correctly map filtered indices to original PCD indices
    for (const filteredIdx of this.selectedIndices) {
        // Map filtered index to original PCD index
        const originalIdx = this.originalIndexMap ? this.originalIndexMap[filteredIdx] : filteredIdx;

        if (originalIdx !== undefined && originalIdx >= 0 && originalIdx < this.lidar.pcd.classify.length) {
            // Update original PCD classify data
            this.lidar.pcd.classify[originalIdx] = classifyValue;

            // Also update the filtered geometry's classify attribute for immediate visual feedback
            if (geometryClassify && filteredIdx < geometryClassify.array.length) {
                geometryClassify.array[filteredIdx] = classifyValue;
            }
        }
    }

    // Log classify values AFTER update
    if (geometryClassify) {
        const sampleIndices = Array.from(this.selectedIndices).slice(0, 5);
        Logger.log('  - Classify values AFTER:',
            sampleIndices.map(fi => `g[${fi}]=${geometryClassify.array[fi]}`).join(', '));
    }

    // Mark geometry classify attribute as needing update
    if (geometryClassify) {
        geometryClassify.needsUpdate = true;
    }

    this.refreshPointCloud();
    this.clearPolygonAndSelection();

    Logger.log(`Applied classify ${classifyValue} to ${count} points`);
};

ClassifyAnnotator.prototype.clearAllClassifications = function() {
    if (!this.lidar.pcd?.classify) return;

    if (!confirm('确定要清除所有分类标注吗？所有未保存的分类将被重置为"未分类"状态。')) {
        return;
    }

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
};

// ============================================================================
// History Management
// ============================================================================

ClassifyAnnotator.prototype.saveToHistory = function() {
    if (this.selectedIndices.size === 0 || !this.lidar.pcd?.classify) return;

    const snapshot = new Map();
    // Use originalIndexMap to save the original PCD indices
    for (const filteredIdx of this.selectedIndices) {
        const originalIdx = this.originalIndexMap ? this.originalIndexMap[filteredIdx] : filteredIdx;
        if (originalIdx !== undefined && originalIdx >= 0 && originalIdx < this.lidar.pcd.classify.length) {
            snapshot.set(originalIdx, this.lidar.pcd.classify[originalIdx]);
        }
    }

    this.selectionHistory.push(snapshot);
    this.trimHistory();
};

ClassifyAnnotator.prototype.saveAllToHistory = function() {
    if (!this.lidar.pcd?.classify) return;

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
};

// ============================================================================
// Selection Management
// ============================================================================

ClassifyAnnotator.prototype.clearSelection = function() {
    this.selectedIndices.clear();
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
    Logger.log('refreshPointCloud called');
    Logger.log('  - lidar exists:', !!this.lidar);
    Logger.log('  - points exists:', !!this.lidar?.points);
    Logger.log('  - geometry vertex count:', this.lidar?.points?.geometry?.attributes?.position?.count);

    const geometryClassify = this.lidar?.points?.geometry?.getAttribute('classify');
    const geometryPositions = this.lidar?.points?.geometry?.getAttribute('position');
    const geometryColors = this.lidar?.points?.geometry?.getAttribute('color');

    Logger.log('  - Geometry classify exists:', !!geometryClassify);
    Logger.log('  - Geometry positions exists:', !!geometryPositions);
    Logger.log('  - Geometry colors exists:', !!geometryColors);

    if (geometryClassify && geometryPositions && this.selectedIndices.size > 0) {
        Logger.log('  - Geometry classify array length:', geometryClassify.array.length);
        // Log classify values and positions for sample indices
        const sampleIndices = Array.from(this.selectedIndices).slice(0, 3);
        for (const fi of sampleIndices) {
            const posIdx = fi * 3;
            Logger.log(`  - filtered[${fi}]: classify=${geometryClassify.array[fi]}, pos=(${geometryPositions.array[posIdx].toFixed(2)}, ${geometryPositions.array[posIdx+1].toFixed(2)}, ${geometryPositions.array[posIdx+2].toFixed(2)})`);
        }
    }

    if (this.lidar?.color_points) {
        this.lidar.color_points();
        Logger.log('  - Called color_points()');
    }

    // Log colors AFTER color_points() for sample indices
    if (geometryColors && this.selectedIndices.size > 0) {
        const sampleIndices = Array.from(this.selectedIndices).slice(0, 3);
        for (const fi of sampleIndices) {
            const colorIdx = fi * 3;
            Logger.log(`  - filtered[${fi}] color AFTER: RGB=(${geometryColors.array[colorIdx].toFixed(2)}, ${geometryColors.array[colorIdx+1].toFixed(2)}, ${geometryColors.array[colorIdx+2].toFixed(2)})`);
        }
    }

    // Force geometry update
    if (this.lidar?.points?.geometry) {
        const colorAttr = this.lidar.points.geometry.getAttribute('color');
        if (colorAttr) {
            colorAttr.needsUpdate = true;
        }
    }

    // Force render
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

    const data = {
        scene: this.lidar.frameInfo.scene,
        frame: this.lidar.frameInfo.frame,
        classify: Array.from(this.lidar.pcd.classify),
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
            Logger.log('Saved successfully');
            alert('分类标注已保存到PCD文件');
        } else {
            Logger.error('Save failed:', result.error);
            alert('保存失败: ' + result.error);
        }
    })
    .catch(error => {
        Logger.error('Save error:', error);
        alert('保存出错: ' + error.message);
    });
};

export { ClassifyAnnotator };
