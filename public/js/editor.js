import * as THREE from './lib/three.module.js';

import {ViewManager} from "./view.js";
import {FastToolBox, FloatLabelManager} from "./floatlabel.js";
import {Mouse} from "./mouse.js";
import {BoxEditor, BoxEditorManager} from "./box_editor.js";
import {ImageContextManager} from "./image.js";
import {globalObjectCategory} from "./obj_cfg.js";

import {objIdManager} from "./obj_id_list.js";
import {Header} from "./header.js";
import {BoxOp} from './box_op.js';
import {AutoAdjust} from "./auto-adjust.js";
import {PlayControl} from "./play.js";
import {reloadWorldList, saveWorldList} from "./save.js";
import {logger, create_logger} from "./log.js";
import {autoAnnotate} from "./auto_annotate.js";
import {Calib} from "./calib.js";
import {Trajectory} from "./trajectory.js";
import { ContextMenu } from './context_menu.js';
import { InfoBox } from './info_box.js';
import { ConfigUi } from './config_ui.js';
import { MovableView } from './popup_dialog.js';
import {globalKeyDownManager} from './keydown_manager.js';
import {vector_range} from "./util.js"
import { checkScene } from './error_check.js';
import { OdomManager } from './odom.js';


function Editor(editorUi, wrapperUi, editorCfg, data, name="editor"){

    // create logger before anything else.
    create_logger(editorUi.querySelector("#log-wrapper"), editorUi.querySelector("#log-button"));
    this.logger = logger;

    this.editorCfg = editorCfg;
    this.sideview_enabled = true;
    this.editorUi = editorUi;
    this.wrapperUi = wrapperUi;
    this.container = null;
    this.name = name;

    this.data = data;
    this.scene = null;
    this.renderer = null;
    this.selected_box = null;
    this.windowWidth = null;
    this.windowHeight= null;
    this.floatLabelManager = null;
    this.operation_state = {
            key_pressed : false,
            box_navigate_index:0,
        };
    this.frame_select_state = {
        active: false,
        selected_boxes: [],
        original_colors: [],
        clipboard: null,
    };
    this.view_state = {
        lock_obj_track_id : "",
        lock_obj_in_highlight : false,  // focus mode
        autoLock: function(trackid, focus){
            this.lock_obj_track_id = trackid;
            this.lock_obj_in_highlight = focus;
        }
    };
    this.calib = new Calib(this.data, this);

    this.header = null;
    this.imageContextManager = null;
    this.boxOp = null;
    this.boxEditorManager  = null; 
    this.params={};

    this.currentMainEditor = this;  // who is on focus, this or batch-editor-manager?

    this.init = function(editorUi) {
    
        let self = this;
        this.editorUi = editorUi;
    
        


        this.playControl = new PlayControl(this.data);

        this.configUi = new ConfigUi(editorUi.querySelector("#config-button"), editorUi.querySelector("#config-wrapper"), this);

        this.header = new Header(editorUi.querySelector("#header"), this.data, this.editorCfg,
            (e)=>{
                this.scene_changed(e.currentTarget.value);
                //event.currentTarget.blur();
            },        
            (e)=>{this.frame_changed(e)},
            (e)=>{this.object_changed(e)},
            (e)=>{this.camera_changed(e)}        
        );


        //
        // that way, the operation speed may be better
        // if we load all worlds, we can speed up batch-mode operations, but the singl-world operations slows down.
        // if we use two seperate scenes. can we solve this problem?
        //
        this.scene = new THREE.Scene();
        this.mainScene = this.scene; //new THREE.Scene();
        
        this.data.set_webglScene(this.scene, this.mainScene);

        

        this.renderer = new THREE.WebGLRenderer( { antialias: true, preserveDrawingBuffer: true } );
        this.renderer.setPixelRatio( window.devicePixelRatio );
        
        this.container = editorUi.querySelector("#container");
        this.container.appendChild( this.renderer.domElement );   
        
        

        this.boxOp = new BoxOp(this.data);
        this.viewManager = new ViewManager(this.container, this.scene, this.mainScene, this.renderer, 
            function(){self.render();}, 
            function(box){self.on_box_changed(box)},
            this.editorCfg);
        

        this.imageContextManager = new ImageContextManager(
                this.editorUi.querySelector("#content"), 
                this.editorUi.querySelector("#camera-selector"),
                this.editorCfg,
                (lidar_points)=>this.on_img_click(lidar_points));


        if (!this.editorCfg.disableRangeCircle)
            this.addRangeCircle();
    
        this.floatLabelManager = new FloatLabelManager(this.editorUi, this.container, this.viewManager.mainView,function(box){self.selectBox(box);});
        this.fastToolBox = new FastToolBox(this.editorUi.querySelector("#obj-editor"), (event)=>this.handleFastToolEvent(event));
        //this.controlGui = this.init_gui();
        
        this.axis = new THREE.AxesHelper(1);

        this.scene.add(this.axis);
    
        window.addEventListener( 'resize', function(){self.onWindowResize();}, false );
        

        if (!this.editorCfg.disableMainViewKeyDown){
            // this.container.onmouseenter = (event)=>{
            //     this.container.focus();
            // };

            // this.container.onmouseleave = (event)=>{
            //     this.container.blur();                
            // };

            //this.container.addEventListener( 'keydown', function(e){self.keydown(e);} );
            //this.editorUi.addEventListener( 'keydown', e=>this.keydown(e); );

            this.keydownHandler = (event)=>this.keydown(event);
            //this.keydownDisabled = false;
            //document.removeEventListener('keydown', this.keydownHandler);
            //document.addEventListener( 'keydown', this.keydownHandler);
            globalKeyDownManager.register(this.keydownHandler, "main editor");
        }

        this.globalKeyDownManager = globalKeyDownManager;

        this.objectTrackView = new Trajectory(
            this.editorUi.querySelector("#object-track-wrapper")
        );

        this.infoBox = new InfoBox(
            this.editorUi.querySelector("#info-wrapper")
        );

        this.contextMenu = new ContextMenu(this.editorUi.querySelector("#context-menu-wrapper"));        

        

        this.boxEditorManager = new BoxEditorManager(
            document.querySelector("#batch-box-editor"),
            this.viewManager,
            this.objectTrackView,
            this.editorCfg,
            this.boxOp,
            this.header,
            this.contextMenu,
            this.configUi,
            (b)=>this.on_box_changed(b),
            (b,r)=>this.remove_box(b,r),   // on box remove
            ()=>{
                // this.on_load_world_finished(this.data.world);
                // this.imageContextManager.hide();
                // this.floatLabelManager.hide();

                // this.viewManager.mainView.disable();
                // this.boxEditor.hide();
                // this.hideGridLines();
                // this.controlGui.hide();
                
            });  //func_on_annotation_reloaded
        this.boxEditorManager.hide();
         
        let boxEditorUi = this.editorUi.querySelector("#main-box-editor-wrapper");
        this.boxEditor= new BoxEditor(
            boxEditorUi,
            null,  // no box editor manager
            this.viewManager, 
            this.editorCfg, 
            this.boxOp, 
            (b)=>this.on_box_changed(b),
            (b)=>this.remove_box(b),
            "main-boxe-ditor");
        this.boxEditor.detach(); // hide it
        this.boxEditor.setResize("both");
        this.boxEditor.moveHandle = new MovableView(
            boxEditorUi.querySelector("#focuscanvas"),
            boxEditorUi.querySelector("#sub-views"),
            ()=>{
                this.boxEditor.update();
                this.render();
            }
        );

        this.mouse = new Mouse(
            this.viewManager.mainView,
            this.operation_state,
            this.container, 
            this.editorUi,
            function(ev){self.handleLeftClick(ev);}, 
            function(ev){self.handleRightClick(ev);}, 
            function(x,y,w,h,ctl,shift){self.handleSelectRect(x,y,w,h,ctl,shift);});

        this.autoAdjust=new AutoAdjust(this.boxOp, this.mouse, this.header);

       
        //this.projectiveViewOps.hide();
    
        if (!this.editorCfg.disableGrid)
            this.installGridLines()
    
        window.onbeforeunload = function() {
            return "Exit?";
            //if we return nothing here (just calling return;) then there will be no pop-up question at all
            //return;
        };

        this.onWindowResize();
    };



    this.run = function(){
        //this.animate();
        this.render();
        //$( "#maincanvas" ).resizable();
        
        
        this.imageContextManager.init_image_op(()=>this.selected_box);

        this.add_global_obj_type();        
    };

    this.hide = function(){
        this.wrapperUi.style.display="none";
    };
    this.show = function(){
        this.wrapperUi.style.display="block";
    };




    this.moveRangeCircle = function(world){
        if (this.rangeCircle.parent){
            world.webglGroup.add(this.rangeCircle);
        }
    };

    this.addRangeCircle= function(){

        var h = 1;

        // 三个圆环半径系数（相对于外层 scale.x/y = 50），对应实际半径 30m/50m/100m
        var ringRadii = [0.6, 1.0, 2.0];
        var body = [];

        var segments=64;
        for (var i = 0; i<segments; i++){
            var theta1 = (2*Math.PI/segments) * i;
            var theta2 = 2*Math.PI/segments * ((i+1)%segments);

            ringRadii.forEach(function(r){
                body.push(r*Math.cos(theta1), r*Math.sin(theta1), h,
                          r*Math.cos(theta2), r*Math.sin(theta2), h);
            });
        }

        this.data.dbg.alloc();
        var bbox = new THREE.BufferGeometry();
        bbox.setAttribute( 'position', new THREE.Float32BufferAttribute(body, 3 ) );

        var lines = new THREE.LineSegments( bbox,
            new THREE.LineBasicMaterial( { color: 0x888800, linewidth: 1, opacity: 0.5, transparent: true } ) );

        var scaleXY = 50;
        var scaleZ = -3;
        lines.scale.set(scaleXY, scaleXY, scaleZ);
        lines.computeLineDistances();

        // 用一个 Group 承载线框和距离文字，方便一起显示/隐藏
        var group = new THREE.Group();
        group.add(lines);

        // 生成一张画好文字的 canvas，返回 Sprite
        function makeDistanceLabel(text){
            var canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 64;
            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.font = 'bold 44px sans-serif';
            ctx.fillStyle = 'rgba(255, 235, 60, 0.95)';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.lineWidth = 4;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.strokeText(text, canvas.width/2, canvas.height/2);
            ctx.fillText(text, canvas.width/2, canvas.height/2);

            var texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;
            var material = new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthTest: false,
                depthWrite: false,
            });
            var sprite = new THREE.Sprite(material);
            // 世界尺寸：宽 8m 高 2m，正好在圆环上方可读
            sprite.scale.set(8, 2, 1);
            return sprite;
        }

        // 每个圆环在 +x / -x / +y / -y 四个方向各贴一个标签，方便任意角度查看
        var offsets = [
            {x: 1, y: 0}, {x: -1, y: 0}, {x: 0, y: 1}, {x: 0, y: -1},
        ];
        ringRadii.forEach(function(r){
            var distance = Math.round(r * scaleXY);   // 30 / 50 / 100 米
            offsets.forEach(function(o){
                var sp = makeDistanceLabel(distance + ' m');
                sp.position.set(o.x * distance, o.y * distance, h);
                group.add(sp);
            });
        });

        this.rangeCircle = group;
        this.scene.add(group);
    };



    this.showRangeCircle = function(show){

        if (show){
            if (this.data.world)
            {
                this.data.world.webglGroup.add(this.rangeCircle);
            }
        }
        else 
        {
            if (this.rangeCircle.parent)
                this.rangeCircle.parent.remove(this.rangeCircle);
        }

        this.render();
    };

    this.hideGridLines = function(){
        var svg = this.editorUi.querySelector("#grid-lines-wrapper");
        svg.style.display="none";
    };
    this.showGridLines = function(){
        var svg = this.editorUi.querySelector("#grid-lines-wrapper");
        svg.style.display="";
    };
    this.installGridLines= function(){
        
        var svg = this.editorUi.querySelector("#grid-lines-wrapper");

        for (var i=1; i<10; i++){
            const line = document. createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", "0%");
            line.setAttribute("y1", String(i*10)+"%");
            line.setAttribute("x2", "100%");
            line.setAttribute("y2", String(i*10)+"%");
            line.setAttribute("class", "grid-line");
            svg.appendChild(line);
        }

        for (var i=1; i<10; i++){
            const line = document. createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("y1", "0%");
            line.setAttribute("x1", String(i*10)+"%");
            line.setAttribute("y2", "100%");
            line.setAttribute("x2", String(i*10)+"%");
            line.setAttribute("class", "grid-line");
            svg.appendChild(line);
        }
        
    };

    this.handleFastToolEvent= function(event){

        let self = this;
        switch (event.currentTarget.id){
        case "label-del":
            self.remove_selected_box();
            self.header.updateModifiedStatus();
            break;
        case "label-gen-id":
            //self.autoAdjust.mark_bbox(self.selected_box);
            //event.currentTarget.blur();
            let id = objIdManager.generateNewUniqueId();
            self.fastToolBox.setValue(self.selected_box.obj_type, id, self.selected_box.obj_attr);

            self.setObjectId(id);
            break;
        case "label-copy":
            if (!this.selected_box.obj_track_id)
            {
                this.infoBox.show("Error", "Please assign object track ID.");
            
            }
            else
            {
                self.autoAdjust.mark_bbox(self.selected_box);
            }
            break;

        case "label-paste":
            //this.autoAdjust.smart_paste(self.selected_box, null, (b)=>this.on_box_changed(b));
            this.boxOp.auto_rotate_xyz(this.selected_box, null, null, 
                (b)=>this.on_box_changed(b),
                "noscaling");
            //event.currentTarget.blur();
           break;

        case "label-batchedit":
            {

                if (!this.ensureBoxTrackIdExist())
                    break;

                if (!this.ensurePreloaded())
                    break;
                    
                this.header.setObject(this.selected_box.obj_track_id);
                this.editBatch(
                    this.data.world.frameInfo.scene,
                    this.data.world.frameInfo.frame,
                    this.selected_box.obj_track_id,
                    this.selected_box.obj_type
                );
            }
            break;


        case "label-trajectory":
            this.showTrajectory();            
            break;

        case "label-edit":
            event.currentTarget.blur();
            self.selectBox(self.selected_box);
            break;
        

        // case "label-reset":
        //     event.currentTarget.blur();
        //     if (self.selected_box){
        //         //switch_bbox_type(this.selected_box.obj_type);
        //         self.transform_bbox("reset");
        //     }        
        //     break;

        case "label-highlight":
            event.currentTarget.blur();
            if (self.selected_box.in_highlight){
                self.cancelFocus(self.selected_box);
                self.view_state.lock_obj_in_highlight = false
            }
            else {
                self.focusOnSelectedBox(self.selected_box);
            }
            break;

        case "label-rotate":
            event.currentTarget.blur();
            self.transform_bbox("z_rotate_reverse");
            break;    
        
        case "object-category-selector":
            this.object_category_changed(event);
            break;
        case "object-track-id-editor":
            this.object_track_id_changed(event);
            break;
        case "attr-input":
            this.object_attribute_changed(event.currentTarget.value);
            break;
        default:
            this.handleContextMenuEvent(event);
            break;   
        }

    };

    this.cancelFocus= function(box){
        
        box.in_highlight = false;
        //view_state.lock_obj_in_highlight = false; // when user unhighlight explicitly, set it to false
        this.data.world.lidar.cancel_highlight(box);
        this.floatLabelManager.restore_all();
        
        this.viewManager.mainView.save_orbit_state(box.scale);
        this.viewManager.mainView.orbit.reset();
    };

    this.focusOnSelectedBox = function(box){
        if (this.editorCfg.disableMainView)
            return;

        if (box){
            this.data.world.lidar.highlight_box_points(box);
            
            this.floatLabelManager.hide_all();
            this.viewManager.mainView.orbit.saveState();

            //this.viewManager.mainView.camera.position.set(this.selected_box.position.x+this.selected_box.scale.x*3, this.selected_box.position.y+this.selected_box.scale.y*3, this.selected_box.position.z+this.selected_box.scale.z*3);

            let posG = this.data.world.lidarPosToScene(box.position);
            this.viewManager.mainView.orbit.target.x = posG.x;
            this.viewManager.mainView.orbit.target.y = posG.y;
            this.viewManager.mainView.orbit.target.z = posG.z;

            this.viewManager.mainView.restore_relative_orbit_state(box.scale);
            this.viewManager.mainView.orbit.update();

            this.render();
            box.in_highlight=true;
            this.view_state.lock_obj_in_highlight = true;
        }
    };
    
    this.showTrajectory = function(){

        if (!this.selected_box)
            return;
            
        if (!this.selected_box.obj_track_id){
            console.error("no track id");
            return;
        }

        let tracks = this.data.worldList.map(w=>{
            let box = w.annotation.findBoxByTrackId(this.selected_box.obj_track_id);
            let ann = null;
            if (box){
                ann = w.annotation.boxToAnn(box);
                ann.psr.position = w.lidarPosToUtm(ann.psr.position);
                ann.psr.rotation = w.lidarRotToUtm(ann.psr.rotation);
            } 
            return [w.frameInfo.frame, ann, w===this.data.world]
        });


        tracks.sort((a,b)=> (a[0] > b[0])? 1 : -1);

        this.objectTrackView.setObject(
            this.selected_box.obj_type,
            this.selected_box.obj_track_id,
            tracks,
            (targetFrame)=>{  //onExit
                this.load_world(this.data.world.frameInfo.scene, targetFrame);
            }
        );
    }

    // return true to close contextmenu
    // return false to keep contextmenu
    this.handleContextMenuEvent = function(event){

        switch(event.currentTarget.id)
        {

        case "cm-play-2fps":
            this.playControl.play((w)=>{this.on_load_world_finished(w)}, 2);
            break;
        case "cm-play-10fps":
            this.playControl.play((w)=>{this.on_load_world_finished(w)}, 10);
            break;
        case "cm-play-20fps":
            this.playControl.play((w)=>{this.on_load_world_finished(w)}, 20);
            break;
        case "cm-play-50fps":
            this.playControl.play((w)=>{this.on_load_world_finished(w)}, 50);
            break;
        case 'cm-paste':
            {
                let box = this.add_box_on_mouse_pos_by_ref();

                if (!event.shiftKey)
                {
                    logger.log('paste without auto-adjusting');
                    this.boxOp.auto_rotate_xyz(box, null, null, 
                        b=>this.on_box_changed(b),
                        "noscaling");
                }
            }
            break;
        case 'cm-prev-frame':
            this.previous_frame();
            break;
        case 'cm-next-frame':
            this.next_frame();
            break;
        case 'cm-last-frame':
            this.last_frame();
            break;
        case 'cm-first-frame':
            this.first_frame();
            break;
        case 'cm-auto-annotate-detect':
            {
                // 主视图右键 Auto Annotate → Detect：对当前帧点云调 CenterPoint，
                // 结果覆盖当前帧标签、保存到磁盘、刷新前端。
                let curWorld = this.data.world;
                if (!curWorld) break;
                autoAnnotate(curWorld, () => {
                    this.on_load_world_finished(curWorld);
                    saveWorldList([curWorld]);
                });
            }
            break;

        case 'cm-auto-annotate-id':
            {
                // 主视图右键 Auto Annotate → ID：
                // Clip 级单调递增原则：整段 clip 里用过的 id 不能复用。
                // 1. 收集当前 scene 所有已加载帧 + objIdManager（覆盖未加载帧）里的历史 id。
                // 2. 保留当前帧"合理 id"（正整数、在本帧内唯一）。
                // 3. 需要重分配的 box，从 max(clip_all_ids)+1 往后依次分配，确保单调递增。
                // 4. 只保存当前帧。
                let curWorld = this.data.world;
                if (!curWorld || !curWorld.annotation || !curWorld.annotation.boxes) break;

                const boxes = curWorld.annotation.boxes;
                if (boxes.length === 0) break;

                const isValidInt = (v) => {
                    if (v === null || v === undefined || v === '') return false;
                    const n = parseInt(v, 10);
                    return Number.isFinite(n) && n > 0 && String(n) === String(v).trim();
                };

                // 步骤 1：收集整段 clip（当前 scene）所有已使用 id
                // —— 来自所有已加载 world
                const currentScene = curWorld.frameInfo.scene;
                const allClipIds = new Set();
                this.data.worldList
                    .filter(w => w.frameInfo.scene === currentScene && w.annotation && w.annotation.boxes)
                    .forEach(w => {
                        w.annotation.boxes.forEach(b => {
                            if (isValidInt(b.obj_track_id))
                                allClipIds.add(parseInt(b.obj_track_id, 10));
                        });
                    });
                // —— 来自 objIdManager（覆盖未加载帧里的已知 id）
                objIdManager.objectList.forEach(obj => {
                    if (isValidInt(obj.id)) allClipIds.add(parseInt(obj.id, 10));
                });

                // 步骤 2：当前帧内 id 计数，找出"合理"的（正整数 + 本帧唯一）
                const idCountInFrame = {};
                boxes.forEach(b => {
                    if (isValidInt(b.obj_track_id))
                        idCountInFrame[b.obj_track_id] = (idCountInFrame[b.obj_track_id] || 0) + 1;
                });

                // 步骤 3：需要重分配的 box
                const needNewId = boxes.filter(b => {
                    const id = b.obj_track_id;
                    return !isValidInt(id) || idCountInFrame[id] > 1;
                });

                if (needNewId.length === 0) {
                    logger.log('[auto-id] 当前帧所有 id 均合理，无需修改');
                    break;
                }

                // 步骤 4：从 max(clip_all_ids)+1 开始分配（严格单调递增）
                let nextId = allClipIds.size > 0 ? Math.max(...allClipIds) + 1 : 1;
                const getNextAvailable = () => {
                    // allClipIds 已包含所有历史 id，直接从 nextId 顺序累加即可
                    while (allClipIds.has(nextId)) nextId++;
                    const id = nextId;
                    allClipIds.add(id);
                    nextId++;
                    return id;
                };

                needNewId.forEach(b => {
                    const newId = getNextAvailable();
                    logger.log(`[auto-id] box(${b.obj_type}) id: "${b.obj_track_id}" → ${newId}`);
                    b.obj_track_id = newId;
                    this.floatLabelManager.set_object_track_id(b.obj_local_id, b.obj_track_id);
                    objIdManager.addObject({ category: b.obj_type, id: b.obj_track_id });
                });

                curWorld.annotation.setModified();
                this.header.updateModifiedStatus();
                this.on_load_world_finished(curWorld);
                saveWorldList([curWorld]);
                logger.log(`[auto-id] 已重分配 ${needNewId.length} 个 id（从 clip 最大 id+1 开始），保存当前帧`);
            }
            break;

        case 'cm-save':
            saveWorldList(this.data.worldList);
            break;
       
        case "cm-reload":
            {
                reloadWorldList([this.data.world], ()=>{
                    this.on_load_world_finished(this.data.world);
                    this.header.updateModifiedStatus();
                });
                
            }
            break;

        case "cm-reload-all":
            {
                let modifiedFrames = this.data.worldList.filter(w=>w.annotation.modified);

                if (modifiedFrames.length > 0)
                {
                    this.infoBox.show(
                        "Confirm",
                        `Discard changes to ${modifiedFrames.length} frames, continue to reload?`,
                        ["yes","no"],
                        (choice)=>{
                            if (choice=="yes")
                            {
                                reloadWorldList(this.data.worldList, ()=>{
                                    this.on_load_world_finished(this.data.world);
                                    this.header.updateModifiedStatus();
                                });
                            }
                        }
                    );                
                }
                else
                {
                    reloadWorldList(this.data.worldList, ()=>{
                        this.on_load_world_finished(this.data.world);
                        this.header.updateModifiedStatus();
                    });

                    objIdManager.forceUpdate();
                }
            }
            break;
    

        case "cm-stop":
            this.playControl.stop_play();
            break;
        case "cm-pause":
            this.playControl.pause_resume_play();
            break;
        
        case "cm-prev-object":
            this.select_previous_object();
            break;
    
        case "cm-next-object":
            this.select_previous_object();
            break;

        case "cm-show-frame-info":
            {
                let info = {"scend-id": this.data.world.frameInfo.scene,
                            "frame": this.data.world.frameInfo.frame
                           };
                
                if (this.data.world.frameInfo.sceneMeta.desc)
                {
                    info = {
                        ...info, 
                        ...this.data.world.frameInfo.sceneMeta.desc,                        
                    };
                }

                this.infoBox.show("Frame info - " + this.data.world.frameInfo.scene, JSON.stringify(info,null,"<br>"));
            }
            break;

        case "cm-show-stat":
            {
                let scene = this.data.world.frameInfo.scene;
                objIdManager.load_obj_ids_of_scene(scene, (objs)=>{
                    let info = {
                        objects: objs.length,
                        boxes: objs.reduce((a,b)=>a+b.count, 0),
                        frames: this.data.world.frameInfo.sceneMeta.frames.length,
                    };

                    this.infoBox.show("Stat - " + scene, JSON.stringify(info, null,"<br>"));
                });
            }
            break;
        /// object

        case 'cm-check-scene':
            {
                let scene = this.data.world.frameInfo.scene;
                checkScene(scene);   
                logger.show();             
                logger.errorBtn.onclick();
            }
            break;
        case "cm-reset-view":
            this.resetView();
            break;
        case "cm-delete":
            this.remove_selected_box();
            this.header.updateModifiedStatus();
            break;

        case "cm-edit-multiple-instances":
            this.enterBatchEditMode();
            
            break;
        case "cm-auto-ann-background":
            {
                this.autoAnnInBackground();
               
            }
            break;
        case "cm-interpolate-background":
            {
                this.interpolateInBackground();
            }
            break;
        case "cm-show-trajectory":

            this.showTrajectory();
            break;

        case "cm-select-as-ref":
            if (!this.selected_box.obj_track_id)
            {
                this.infoBox.show("Error", "Please assign object track ID.");
                return false;
            }
            else
            {
                this.autoAdjust.mark_bbox(this.selected_box);
            }
            break;
        
        case "cm-change-id-to-ref":
            if (!this.ensureRefObjExist())
                break;

            this.setObjectId(this.autoAdjust.marked_object.ann.obj_id);
            this.fastToolBox.setValue(this.selected_box.obj_type, 
                this.selected_box.obj_track_id, 
                this.selected_box.obj_attr);

            break;
        case "cm-change-id-to-ref-in-scene":

            if (!this.ensureBoxTrackIdExist())
                break;
            if (!this.ensurePreloaded())
                break;
            if (!this.ensureRefObjExist())
                break;

            this.data.worldList.forEach(w=>{
                let box = w.annotation.boxes.find(b=>b.obj_track_id === this.selected_box.obj_track_id &&  b.obj_type === this.selected_box.obj_type);
                if (box && box !== this.selected_box){
                    box.obj_track_id = this.autoAdjust.marked_object.ann.obj_id;
                    w.annotation.setModified();
                }
            });

            
            this.setObjectId(this.autoAdjust.marked_object.ann.obj_id);
            this.fastToolBox.setValue(this.selected_box.obj_type, 
                this.selected_box.obj_track_id, 
                this.selected_box.obj_attr);

            break;
        case "cm-follow-ref":

            if (!this.ensureBoxTrackIdExist())
                break;
            if (!this.ensurePreloaded())
                break;
            this.autoAdjust.followsRef(this.selected_box);
            this.header.updateModifiedStatus();
            this.editBatch(
                this.data.world.frameInfo.scene,
                this.data.world.frameInfo.frame,
                this.selected_box.obj_track_id,
                this.selected_box.obj_type
            );
            break;
        case 'cm-follow-static-objects':
            if (!this.ensureBoxTrackIdExist())
                break;
            if (!this.ensurePreloaded())
                break;
            this.autoAdjust.followStaticObjects(this.selected_box);
            this.header.updateModifiedStatus();

            this.editBatch(
                this.data.world.frameInfo.scene,
                this.data.world.frameInfo.frame,
                this.selected_box.obj_track_id,
                this.selected_box.obj_type
            );

            break;
        case "cm-sync-followers":
            
            if (!this.ensurePreloaded())
                break;
            this.autoAdjust.syncFollowers(this.selected_box);
            this.header.updateModifiedStatus();
            this.render();
            break;


        case "cm-delete-obj":
            {
                //let saveList=[];
                this.data.worldList.forEach(w=>{
                    let box = w.annotation.boxes.find(b=>b.obj_track_id === this.selected_box.obj_track_id);
                    if (box && box !== this.selected_box){
                        w.annotation.unload_box(box);
                        w.annotation.remove_box(box);
                        //saveList.push(w);
                        w.annotation.setModified();
                    }
                });

                //saveWorldList(saveList);
                this.remove_selected_box();
                this.header.updateModifiedStatus();
            }
            break;

        case "cm-modify-obj-type":
            {
                if (!this.ensurePreloaded())
                    break;
                //let saveList=[];
                this.data.worldList.forEach(w=>{
                    let box = w.annotation.boxes.find(b=>b.obj_track_id === this.selected_box.obj_track_id);
                    if (box && box !== this.selected_box){
                        box.obj_type = this.selected_box.obj_type;
                        box.obj_attr = this.selected_box.obj_attr;
                        //saveList.push(w);
                        w.annotation.setModified();
                    }                
                    
                });

                //saveWorldList(saveList);
                this.header.updateModifiedStatus();
            }
            break;

        case "cm-modify-obj-size":
            {
                if (!this.ensurePreloaded())
                    break;
                //let saveList=[];
                this.data.worldList.forEach(w=>{
                    let box = w.annotation.boxes.find(b=>b.obj_track_id == this.selected_box.obj_track_id);
                    if (box && box !== this.selected_box){
                        box.scale.x = this.selected_box.scale.x;
                        box.scale.y = this.selected_box.scale.y;
                        box.scale.z = this.selected_box.scale.z;
                        //saveList.push(w);

                        w.annotation.setModified();
                    }                
                    
                });

                //saveWorldList(saveList);
                this.header.updateModifiedStatus();
            }
            break;


        default:
            console.log('unhandled', event.currentTarget.id, event.type);
        }

        return true; 
    };

    // this.animate= function() {
    //     let self=this;
    //     requestAnimationFrame( function(){self.animate();} );
    //     this.viewManager.mainView.orbit_orth.update();
    // };



    this.render= function(){

        this.viewManager.mainView.render();
        this.boxEditor.boxView.render();

        this.floatLabelManager.update_all_position();
        if (this.selected_box){
            this.fastToolBox.setPos(this.floatLabelManager.getLabelEditorPos(this.selected_box.obj_local_id));
        }
    };

    
    this.resetView = function(targetPos){

        if (!targetPos){
            let center = this.data.world.lidar.computeCenter();
            targetPos = {...center};//{x:0, y:0, z:50};
            targetPos.z += 50;
        }
        else
            targetPos.z = 50;

        let pos = this.data.world.lidarPosToScene(targetPos);
        this.viewManager.mainView.orbit.object.position.set(pos.x, pos.y, pos.z);  //object is camera
        this.viewManager.mainView.orbit.target.set(pos.x, pos.y, 0);
        this.viewManager.mainView.orbit.update(); 
        this.render();
    };

    this.scene_changed= async function(sceneName){
        
        //var sceneName = event.currentTarget.value;

        if (sceneName.length == 0){
            return;
        }
        
        console.log("choose sceneName " + sceneName);
        var meta = this.data.getMetaBySceneName(sceneName);

        if (!meta)
        {
            this.editorUi.querySelector("#frame-selector").innerHTML = "<option>--frame--</option>";
            meta = await this.data.readSceneMetaData(sceneName);
        }

        var frame_selector_str = meta.frames.map(function(f){
            return "<option value="+f+">"+f + "</option>";
        }).reduce(function(x,y){return x+y;}, "<option>--frame--</option>");

        this.editorUi.querySelector("#frame-selector").innerHTML = frame_selector_str;
        
        
        if (meta.camera){
            this.imageContextManager.updateCameraList(meta.camera);
        }

        //load_obj_ids_of_scene(sceneName);
    };

    this.frame_changed= function(event){
        var sceneName = this.editorUi.querySelector("#scene-selector").value;

        if (sceneName.length == 0 && this.data.world)
        {
            sceneName = this.data.world.frameInfo.scene;
        }

        if (sceneName.length == 0){
            return;
        }

        var frame =  event.currentTarget.value;
        console.log(sceneName, frame);
        this.load_world(sceneName, frame);        
        event.currentTarget.blur();
    };


    this.ensureBoxTrackIdExist = function()
    {
        if (!this.selected_box.obj_track_id)
        {
            this.infoBox.show("Error", "Please assign object track ID.");
            return false;
        }

        return true;
    }

    this.ensureRefObjExist = function()
    {
        if (!this.autoAdjust.marked_object)
        {
            this.infoBox.show("Notice", 'No reference object was selected');
            return false;
        }

        
        return true;
    }
    this.ensurePreloaded = function()
    {
        let worldList = this.data.worldList.filter(w=>w.frameInfo.scene == this.data.world.frameInfo.scene);
        worldList = worldList.sort((a,b)=>a.frameInfo.frame_index - b.frameInfo.frame_index);

        let meta = this.data.get_current_world_scene_meta();

        
        let allLoaded = worldList.map(w=>w.preloaded()).reduce((a,b)=>a && b, true);

        if ((worldList.length < meta.frames.length && worldList.length <= 60) || (!allLoaded))
        {
            this.data.forcePreloadScene(this.data.world.frameInfo.scene, this.data.world);

            this.infoBox.show("Notice", 
                `Loading scene in background. Please try again later.`);
            return false;
        }

        
        return true;
    }


    this.interpolateInBackground = function()
    {
        
        if (!this.ensureBoxTrackIdExist())
        return;

        if (!this.ensurePreloaded())
            return;

        let worldList = this.data.worldList.filter(w=>w.frameInfo.scene == this.data.world.frameInfo.scene);
        worldList = worldList.sort((a,b)=>a.frameInfo.frame_index - b.frameInfo.frame_index);
        let boxList = worldList.map(w=>w.annotation.findBoxByTrackId(this.selected_box.obj_track_id));

        let applyIndList = boxList.map(b=>true);
        this.boxOp.interpolateAsync(worldList, boxList, applyIndList).then(ret=>{
            this.header.updateModifiedStatus();
            this.viewManager.render();
        });
    };
    this.enterBatchEditMode = function()
    {
        if (!this.ensureBoxTrackIdExist())
           return;

        if (!this.ensurePreloaded())
            return;

        this.header.setObject(this.selected_box.obj_track_id);

        this.editBatch(
            this.data.world.frameInfo.scene,
            this.data.world.frameInfo.frame,
            this.selected_box.obj_track_id,
            this.selected_box.obj_type
        );
    };

    this.autoAnnInBackground = function()
    {
        if (!this.ensureBoxTrackIdExist())
            return;

        if (!this.ensurePreloaded())
            return;

        let worldList = this.data.worldList.filter(w=>w.frameInfo.scene == this.data.world.frameInfo.scene);
        worldList = worldList.sort((a,b)=>a.frameInfo.frame_index - b.frameInfo.frame_index);



        let boxList = worldList.map(w=>w.annotation.findBoxByTrackId(this.selected_box.obj_track_id));

        let onFinishOneBox = (i)=>{
            this.viewManager.render();
        }
        let applyIndList = boxList.map(b=>true);
        let dontRotate = false;

        this.boxOp.interpolateAndAutoAdjustAsync(worldList, boxList, onFinishOneBox, applyIndList, dontRotate).then(ret=>{
            this.header.updateModifiedStatus();
        });
    };


    this.editBatch = function(sceneName, frame, objectTrackId, objectType){

        

        //this.keydownDisabled = true;
        // hide something
        this.imageContextManager.hide();
        this.floatLabelManager.hide();

        //this.floatLabelManager.showFastToolbox();

        this.viewManager.mainView.disable();
        this.boxEditor.hide();
        this.hideGridLines();
        //this.controlGui.hide();
        this.editorUi.querySelector("#selectors").style.display='none';
        //this.editorUi.querySelector("#object-selector").style.display='none';
        this.currentMainEditor = this.boxEditorManager;

        this.boxEditorManager.edit(this.data, 
            this.data.getMetaBySceneName(sceneName), 
            frame, 
            objectTrackId,
            objectType,
            (targetFrame, targetTrackId)=>{  //on exit
                this.currentMainEditor = this
                //this.keydownDisabled = false;
                this.viewManager.mainView.enable();

                this.imageContextManager.show();
                this.floatLabelManager.show();

                if (targetTrackId)
                    this.view_state.lock_obj_track_id = targetTrackId;

                this.on_load_world_finished(this.data.world);
                
                // if (this.selected_box){
                //     // attach again, restore box.boxEditor 
                //     // obj type/id may have changed in batch mode
                //     this.floatLabelManager.set_object_track_id(this.selected_box.obj_local_id, this.selected_box.obj_track_id);
                //     this.boxEditor.attachBox(this.selected_box);
                //     this.boxEditor.update();

                //     // update fasttoolbox
                //     this.fastToolBox.setValue(this.selected_box.obj_type, this.selected_box.obj_track_id, this.selected_box.obj_attr);
                // }

                
                this.showGridLines();
                this.render();
                //this.controlGui.show();
                this.editorUi.querySelector("#selectors").style.display='inherit';

                if (targetFrame)
                {
                    this.load_world(this.data.world.frameInfo.scene, targetFrame, ()=>{  // onfinished
                        this.makeVisible(targetTrackId);
                    });
                }
            }
            );
    };

    this.gotoObjectFrame = function(frame, objId)
    {
        this.load_world(this.data.world.frameInfo.scene, frame, ()=>{  // onfinished
            this.makeVisible(objId);
        });
    };

    this.makeVisible = function(targetTrackId){
        let box = this.data.world.annotation.findBoxByTrackId(targetTrackId);

        if (box){
            if (this.selected_box != box){
                this.selectBox(box);
            }

            this.resetView({x:box.position.x, y:box.position.y, z:50});
        }

    };

    this.object_changed = function(event){
        var sceneName = this.data.world.frameInfo.scene; //this.editorUi.querySelector("#scene-selector").value;

        let objectTrackId = event.currentTarget.value;
        let obj = objIdManager.getObjById(objectTrackId);

        this.editBatch(sceneName, null, objectTrackId, obj.category);
    };

    this.camera_changed= function(event){
        var camera_name = event.currentTarget.value;

        this.data.set_active_image(camera_name);
        this.imageContextManager.render_2d_image();

        event.currentTarget.blur();
    };

    this.downloadWebglScreenShot = function(){
        let link = document.createElement("a");
        link.download=`${this.data.world.frameInfo.scene}-${this.data.world.frameInfo.frame}-webgl`;
        link.href=this.renderer.domElement.toDataURL("image/png", 1);
        link.click();
    };

    this.showLog = function() {

    };

    this.annotateByAlg1 = function(){
        autoAnnotate(this.data.world, ()=>this.on_load_world_finished(this.data.world));
    };



    this.object_category_changed= function(event){
        if (this.selected_box){
            
            let category = event.currentTarget.value;

            this.selected_box.obj_type = category;
            this.floatLabelManager.set_object_type(this.selected_box.obj_local_id, this.selected_box.obj_type);
            // this.header.mark_changed_flag();
            // this.updateBoxPointsColor(this.selected_box);
            // this.imageContextManager.boxes_manager.update_obj_type(this.selected_box.obj_local_id, this.selected_box.obj_type);

            // this.render();
            this.on_box_changed(this.selected_box);

            //todo: we don't know if the old one is already deleted.
            // could use object count number?
            objIdManager.addObject({
                category: this.selected_box.obj_type,
                id: this.selected_box.obj_track_id,
            });

        }
    };

    // 判断给定 id 在整段 clip 里除去 `exceptBox` 外是否已经被别的物体用过。
    // 用于"id 单调递增"约束：clip 里已经用过的 id 不能再复用。
    this.isIdUsedInClip = function(id, exceptBox)
    {
        if (id === null || id === undefined || id === '') return false;
        const target = String(id).trim();

        // 1. 遍历所有已加载 world
        const currentScene = this.data.world ? this.data.world.frameInfo.scene : null;
        const usedByOther = this.data.worldList
            .filter(w => w.frameInfo.scene === currentScene && w.annotation && w.annotation.boxes)
            .some(w => w.annotation.boxes.some(b =>
                b !== exceptBox && String(b.obj_track_id).trim() === target
            ));
        if (usedByOther) return true;

        // 2. 兜底：objIdManager 里也可能记录了当前未加载帧的 id（后端 /objs_of_scene 返回的）
        if (objIdManager.objectList.some(o => String(o.id).trim() === target))
        {
            // objIdManager 里的 id 不一定跟当前 exceptBox 关联，需要额外确认这个 id
            // 不是 exceptBox 自身现有的 id。exceptBox 的 id 已经在上一步排除过了，
            // 所以这里只要 objIdManager 里出现，就当作被用过。
            if (!exceptBox || String(exceptBox.obj_track_id).trim() !== target)
            {
                return true;
            }
        }
        return false;
    };

    this.setObjectId = function(id)
    {
        this.selected_box.obj_track_id = id;
        this.floatLabelManager.set_object_track_id(this.selected_box.obj_local_id, this.selected_box.obj_track_id);

        this.view_state.lock_obj_track_id = id;

        //this.header.mark_changed_flag();
        this.on_box_changed(this.selected_box);

        //
        objIdManager.addObject({
            category: this.selected_box.obj_type,
            id: this.selected_box.obj_track_id,
        });
    }

    // 用户在输入框里改 track id：拦截"已用过的 id"，保证 clip 内 id 单调递增。
    this.object_track_id_changed= function(event){
        if (this.selected_box){
            var id = event.currentTarget.value;
            var trimmed = String(id).trim();

            // 空值直接接受（表示清空 id）
            if (trimmed === '')
            {
                this.setObjectId(id);
                return;
            }

            // 只允许正整数
            var n = parseInt(trimmed, 10);
            var isPositiveInt = Number.isFinite(n) && n > 0 && String(n) === trimmed;

            // 已被别的 box 使用（当前帧或其他帧）→ 拒绝
            if (isPositiveInt && this.isIdUsedInClip(trimmed, this.selected_box))
            {
                this.infoBox.show(
                    "ID 已被使用",
                    `ID ${trimmed} 在本 clip 中已经被其他物体使用过（即便当前视野里不存在）。<br>` +
                    `为保证整段 clip 内 tracking id 单调递增，请换一个新 id，<br>` +
                    `或点右侧生成 ID 按钮自动分配下一个可用值。`);
                // 恢复输入框为原来的值
                event.currentTarget.value = this.selected_box.obj_track_id || '';
                return;
            }

            this.setObjectId(id);
        }
    };

    this.object_attribute_changed = function(value){
        if (this.selected_box){
            this.selected_box.obj_attr = value;
            this.floatLabelManager.set_object_attr(this.selected_box.obj_local_id, value);
            this.data.world.annotation.setModified();
            this.header.updateModifiedStatus();
        }
    };

    // this.updateSubviewRangeByWindowResize= function(box){

    //     if (box === null)
    //         return;

    //     if (box.boxEditor)
    //         box.boxEditor.onWindowResize();

    //     this.render();
    // };

    this.handleRightClick= function(event){

        // select new object

        if (!this.data.world){
            return;
        }


        if (event.shiftKey || event.ctrlKey)
        {
            // if ctrl or shift hold, don't select any object.
            this.contextMenu.show("world",event.layerX, event.layerY, this);
            return;
        }


        var intersects = this.mouse.getIntersects( this.mouse.onUpPosition, this.data.world.annotation.boxes );
        if ( intersects.length > 0 ) {
            //var object = intersects[ 0 ].object;
            var object = intersects[ 0 ].object;
            let target_obj = object.userData.object;
            if ( target_obj == undefined ) {
                // helper
                target_obj = object;
            }

            if (target_obj != this.selected_box){
                this.selectBox(target_obj);
            }

            // this.hide_world_context_menu();
            // this.show_object_context_menu(event.layerX, event.layerY);
            this.contextMenu.show("object",event.layerX, event.layerY, this);

        } else {
            // if no object is selected, popup context menu
            //var pos = getMousePosition(renderer.domElement, event.clientX, event.clientY );
            this.contextMenu.show("world",event.layerX, event.layerY, this);
        }
    };

    this.show_world_context_menu= function(posX, posY){
        let menu = this.editorUi.querySelector("#context-menu");
        menu.style.display = "inherit";
        menu.style.left = posX+"px";
        menu.style.top = posY+"px";
        this.editorUi.querySelector("#context-menu-wrapper").style.display = "block";
    };

    this.hide_world_context_menu= function(){
        let menu = this.editorUi.querySelector("#context-menu");
        menu.style.display = "none";
    };

    this.show_object_context_menu= function(posX, posY){
        let menu = this.editorUi.querySelector("#object-context-menu");
        menu.style.display = "inherit";
        menu.style.left = posX+"px";
        menu.style.top = posY+"px";
        this.editorUi.querySelector("#context-menu-wrapper").style.display = "block";
    };

    this.hide_object_context_menu= function(){
        let menu = this.editorUi.querySelector("#object-context-menu");
        menu.style.display = "none";
    };

    this.on_img_click = function(lidar_point_indices){
        
        console.log(lidar_point_indices);

        var self=this;
        let obj_type = "Car";
        this.data.world.lidar.set_spec_points_color(lidar_point_indices, {x:0,y:0,z:1});
        this.data.world.lidar.update_points_color();
        this.render();
        //return;

        let pos = this.data.world.lidar.get_centroid(lidar_point_indices);
        pos.z = 0;

        let rotation = {x:0, y:0, z:this.viewManager.mainView.camera.rotation.z+Math.PI/2};

        let obj_cfg = globalObjectCategory.get_obj_cfg_by_type(obj_type);
        let scale = {   
            x: obj_cfg.size[0],
            y: obj_cfg.size[1],
            z: obj_cfg.size[2]
        };

        let box = this.add_box(pos, scale, rotation, obj_type, "");
        self.boxOp.auto_rotate_xyz(box, null, null, function(b){
            self.on_box_changed(b);
        });

        return;
        /*
        var box = this.data.world.lidar.create_box_by_points(lidar_point_indices, this.viewManager.mainView.camera);
        

        this.scene.add(box);
        
        this.imageContextManager.boxes_manager.add_box(box);
        
        
        this.boxOp.auto_shrink_box(box);
        
        
        // guess obj type here
        
        box.obj_type = guess_obj_type_by_dimension(box.scale);
        
        this.floatLabelManager.add_label(box);

        this.selectBox(box);
        this.on_box_changed(box);

        
        this.boxOp.auto_rotate_xyz(box, function(){
            box.obj_type = guess_obj_type_by_dimension(box.scale);
            self.floatLabelManager.set_object_type(box.obj_local_id, box.obj_type);
            self.floatLabelManager.update_label_editor(box.obj_type, box.obj_track_id);
            self.on_box_changed(box);
        });
        */
        
    };
    
    this.handleSelectRect= function(x,y,w,h, ctrl, shift){
        // y = y+h;
        // x = x*2-1;
        // y = -y*2+1;
        // w *= 2;
        // h *= 2;
        
        // x,y: start cornor, w: width, h: height

        /*
        console.log("main select rect", x,y,w,h);

        this.viewManager.mainView.camera.updateProjectionMatrix();
        this.data.world.select_points_by_view_rect(x,y,w,h, this.viewManager.mainView.camera);
        render();
        render_2d_image();
        */

        // check if any box is inside the rectangle

        this.viewManager.mainView.camera.updateProjectionMatrix();

        let boxes = this.data.world.annotation.find_boxes_inside_rect(x,y,w,h, this.viewManager.mainView.camera);
        if (boxes.length > 0) {

            if (boxes.length == 1){
                this.selectBox(boxes[0])
            }
            else{
                // this is dangerous
                // for (let b in boxes){
                //     this.remove_box(boxes[b],false)
                // }
                // this.render();
            }

            return;
        }

        let points = this.data.world.lidar.select_points_by_view_rect(x,y,w,h, this.viewManager.mainView.camera);

        // show color
        //this.render();

        // return;
        // // create new box
        // var self=this;
        var center_pos = this.mouse.get_screen_location_in_world(x+w/2, y+h/2);
        center_pos = this.data.world.scenePosToLidar(center_pos);
        
        let initRoationZ = this.viewManager.mainView.camera.rotation.z + Math.PI/2;

        let box = this.create_box_by_points(points, initRoationZ);

        let id = objIdManager.generateNewUniqueId();
        box.obj_track_id = id;

        

        //this.scene.add(box);
        
        
        
        if (!shift){
            try{
                this.boxOp.auto_shrink_box(box);
            }
            catch(e)
            {
                logger.log(e);                
            }
        }
        
        // guess obj type here
        
        box.obj_type = globalObjectCategory.guess_obj_type_by_dimension(box.scale);
        
        objIdManager.addObject({
            category: box.obj_type,
            id: box.obj_track_id,
        });



        this.imageContextManager.boxes_manager.add_box(box);
        this.floatLabelManager.add_label(box);

        this.selectBox(box);
        this.on_box_changed(box);

        if (!shift){
            this.boxOp.auto_rotate_xyz(box, ()=>{
                box.obj_type = globalObjectCategory.guess_obj_type_by_dimension(box.scale);
                this.floatLabelManager.set_object_type(box.obj_local_id, box.obj_type);
                this.fastToolBox.setValue(box.obj_type, box.obj_track_id, box.obj_attr);
                this.on_box_changed(box);
            });
        }
        
        
        //floatLabelManager.add_label(box);

        
    };



    this.create_box_by_points=function(points, rotationZ){
        
        let localRot = this.data.world.sceneRotToLidar(new THREE.Euler(0,0,rotationZ, "XYZ"));
        
        let transToBoxMatrix = new THREE.Matrix4().makeRotationFromEuler(localRot)
                                                  .setPosition(0, 0, 0)
                                                  .invert();

       // var trans = transpose(euler_angle_to_rotate_matrix({x:0,y:0,z:rotation_z}, {x:0, y:0, z:0}), 4);

        let relative_position = [];
        let v = new THREE.Vector3();
        points.forEach(function(p){
            v.set(p[0],p[1],p[2]);
            let boxP = v.applyMatrix4(transToBoxMatrix);
            relative_position.push([boxP.x,boxP.y, boxP.z]);
        });

        var relative_extreme = vector_range(relative_position);
        var scale = {
            x: relative_extreme.max[0] - relative_extreme.min[0],
            y: relative_extreme.max[1] - relative_extreme.min[1],
            z: relative_extreme.max[2] - relative_extreme.min[2],
        };

        // enlarge scale a little

        let center = this.boxOp.translateBoxInBoxCoord(
            localRot,
            {
                x: (relative_extreme.max[0] + relative_extreme.min[0])/2,
                y: (relative_extreme.max[1] + relative_extreme.min[1])/2,
                z: (relative_extreme.max[2] + relative_extreme.min[2])/2,
            }
        );

        return this.data.world.annotation.add_box(center, scale, localRot, "Unknown", "");
    };


    this.handleLeftClick= function(event) {

            if (event.ctrlKey){
                //Ctrl+left click to smart paste!
                //smart_paste();
            }
            else{
                //select box /unselect box
                if (!this.data.world || (!this.data.world.annotation.boxes && this.data.world.radars.radarList.length==0 && !this.calib.calib_box)){
                    return;
                }

                let all_boxes = this.data.world.annotation.boxes.concat(this.data.world.radars.getAllBoxes());
                all_boxes = all_boxes.concat(this.data.world.aux_lidars.getAllBoxes());
                
                if (this.calib.calib_box){
                    all_boxes.push(this.calib.calib_box);
                }
                
                let intersects = this.mouse.getIntersects( this.mouse.onUpPosition, all_boxes);

                if (intersects.length == 0){
                    if (this.data.world.radar_box){
                        intersects = this.mouse.getIntersects( this.mouse.onUpPosition, [this.data.world.radar_box]);
                    }
                }

                if ( intersects.length > 0 ) {
                    //var object = intersects[ 0 ].object;
                    var object = intersects[ 0 ].object;
                    if ( object.userData.object !== undefined ) {
                        // helper
                        this.selectBox( object.userData.object );
                    } else {
                        this.selectBox( object );
                    }
                } else {
                    this.unselectBox(null);
                }

                //render();
            }
        

    };

    this.select_locked_object= function(){
        var self=this;
        if (this.view_state.lock_obj_track_id != ""){
            var box = this.data.world.annotation.boxes.find(function(x){
                return x.obj_track_id == self.view_state.lock_obj_track_id;
            })

            if (box){
                this.selectBox(box);

                if (self.view_state.lock_obj_in_highlight){
                    this.focusOnSelectedBox(box);
                }
            }
        }
    };

    // new_object
    this.unselectBox = function(new_object, keep_lock){

        if (new_object==null){
            if (this.viewManager.mainView && this.viewManager.mainView.transform_control.visible)
            {
                //unselect first time
                this.viewManager.mainView.transform_control.detach();
            }else{
                //unselect second time
                if (this.selected_box){
                    // restore from highlight
                    if (this.selected_box.in_highlight){
                        this.cancelFocus(this.selected_box);    

                        if (!keep_lock){
                            this.view_state.lock_obj_in_highlight = false;
                        }
                    } else{
                        // unselected finally
                        //this.selected_box.material.color = new THREE.Color(parseInt("0x"+get_obj_cfg_by_type(this.selected_box.obj_type).color.slice(1)));
                        //this.selected_box.material.opacity = this.data.cfg.box_opacity;
                        this.boxOp.unhighlightBox(this.selected_box);
                        //this.floatLabelManager.unselect_box(this.selected_box.obj_local_id, this.selected_box.obj_type);
                        this.fastToolBox.hide();

                        if (!keep_lock){
                            this.view_state.lock_obj_track_id = "";
                        }

                        this.imageContextManager.boxes_manager.onBoxUnselected(this.selected_box.obj_local_id, this.selected_box.obj_type);
                        this.selected_box = null;
                        this.boxEditor.detach();

                        this.onSelectedBoxChanged(null);
                    }
                }
                else{
                    // just an empty click
                    return;
                }
            }
        }
        else{
            // selected other box
            //unselect all
            this.viewManager.mainView.transform_control.detach();

            
            if (this.selected_box){
                
                // restore from highlight
                
                if (this.selected_box.in_highlight){
                    this.cancelFocus(this.selected_box); 
                    if (!keep_lock){
                        this.view_state.lock_obj_in_highlight = false;
                    }
                }

                this.selected_box.material.color = new THREE.Color(parseInt("0x"+globalObjectCategory.get_obj_cfg_by_type(this.selected_box.obj_type).color.slice(1)));
                this.selected_box.material.opacity = this.data.cfg.box_opacity;                
                //this.floatLabelManager.unselect_box(this.selected_box.obj_local_id);
                this.fastToolBox.hide();
                this.imageContextManager.boxes_manager.onBoxUnselected(this.selected_box.obj_local_id, this.selected_box.obj_type);

                this.selected_box = null;
                this.boxEditor.detach();
                if (!keep_lock)
                    this.view_state.lock_obj_track_id = "";
            }
        }



        this.render();

    };



    this.selectBox = function(object){

        if (this.selected_box != object){
            // unselect old bbox
            
            var in_highlight = false;

            if (this.selected_box){
                in_highlight = this.selected_box.in_highlight;
                this.unselectBox(this.selected_box);
            }

            // select me, the first time
            this.selected_box = object;

            // switch camera
            if (!this.editorCfg.disableMainImageContext){
                var best_camera = this.imageContextManager.choose_best_camera_for_point(
                    this.selected_box.world.frameInfo.sceneMeta,
                    this.selected_box.position);

                if (best_camera){
                    
                    //var image_changed = this.data.set_active_image(best_camera);

                    // if (image_changed){
                    //     this.editorUi.querySelector("#camera-selector").value=best_camera;
                    //     this.imageContextManager.boxes_manager.display_image();
                    // }

                    this.imageContextManager.setBestCamera(best_camera);
                }
            }

            // highlight box
            // shold change this id if the current selected box changed id.
            this.view_state.lock_obj_track_id = object.obj_track_id;

            //this.floatLabelManager.select_box(this.selected_box.obj_local_id);
            
            this.fastToolBox.setPos(this.floatLabelManager.getLabelEditorPos(this.selected_box.obj_local_id));
            this.fastToolBox.setValue(object.obj_type, object.obj_track_id, object.obj_attr);
            this.fastToolBox.show();

            this.boxOp.highlightBox(this.selected_box);

            if (in_highlight){
                this.focusOnSelectedBox(this.selected_box);
            }
            
            this.save_box_info(object); // this is needed since when a frame is loaded, all box haven't saved anything.
                                        // we could move this to when a frame is loaded.
            this.boxEditor.attachBox(object);
            this.onSelectedBoxChanged(object);

        }
        else {
            //reselect the same box
            if (this.viewManager.mainView.transform_control.visible){
                this.change_transform_control_view();
            }
            else{
                //select me the second time
                //object.add(this.viewManager.mainView.transform_control);
                this.viewManager.mainView.transform_control.attach( object );
            }            
        }

        this.render();

        
    };

    this.adjustContainerSize = function()
    {
        let editorRect = this.editorUi.getBoundingClientRect();
        let headerRect = this.editorUi.querySelector("#header").getBoundingClientRect();

        this.container.style.height = editorRect.height - headerRect.height + "px";
    }


    this.onWindowResize= function() {

        this.adjustContainerSize();
        this.boxEditorManager.onWindowResize();

        // use clientwidth and clientheight to resize container
        // but use scrollwidth/height to place other things.
        if ( this.windowWidth != this.container.clientWidth || this.windowHeight != this.container.clientHeight ) {

            //update_mainview();
            if (this.viewManager.mainView)
                this.viewManager.mainView.onWindowResize();

            if (this.boxEditor)
                this.boxEditor.update("dontrender");

            this.windowWidth = this.container.clientWidth;
            this.windowHeight = this.container.clientHeight;
            this.renderer.setSize( this.windowWidth, this.windowHeight );

            //this.viewManager.updateViewPort();

            // update sideview svg if there exists selected box
            // the following update is called in updateSubviewRangeByWindowResize
            // if (this.selected_box){
            //     this.projectiveViewOps.update_view_handle(this.selected_box);
            // }
        }
        
        this.viewManager.render();
    };

    this.change_transform_control_view= function(){
        if (this.viewManager.mainView.transform_control.mode=="scale"){
            this.viewManager.mainView.transform_control.setMode( "translate" );
            this.viewManager.mainView.transform_control.showY=true;
            this.viewManager.mainView.transform_control.showX=true;
            this.viewManager.mainView.transform_control.showz=true;
        }else if (this.viewManager.mainView.transform_control.mode=="translate"){
            this.viewManager.mainView.transform_control.setMode( "rotate" );
            this.viewManager.mainView.transform_control.showY=false;
            this.viewManager.mainView.transform_control.showX=false;
            this.viewManager.mainView.transform_control.showz=true;
        }else if (this.viewManager.mainView.transform_control.mode=="rotate"){
            this.viewManager.mainView.transform_control.setMode( "scale" );
            this.viewManager.mainView.transform_control.showY=true;
            this.viewManager.mainView.transform_control.showX=true;
            this.viewManager.mainView.transform_control.showz=true;
        }
    };

    this.add_box_on_mouse_pos_by_ref = function(){

        let globalP = this.mouse.get_mouse_location_in_world();
        // trans pos to world local pos
        let pos = this.data.world.scenePosToLidar(globalP);

        let refbox = this.autoAdjust.marked_object.ann;
        pos.z = refbox.psr.position.z;

        let id = refbox.obj_id;

        if (this.autoAdjust.marked_object.frame == this.data.world.frameInfo.frame)
        {
            id = "";
        }

        let box = this.add_box(pos, refbox.psr.scale, refbox.psr.rotation, refbox.obj_type, id, refbox.obj_attr);
        
        return box;
    };

    this.add_box_on_mouse_pos= function(obj_type){
        // todo: move to this.data.world
        let globalP = this.mouse.get_mouse_location_in_world();

        // trans pos to world local pos
        let pos = this.data.world.scenePosToLidar(globalP);

        var rotation = new THREE.Euler(0, 0, this.viewManager.mainView.camera.rotation.z+Math.PI/2, "XYZ");
        rotation = this.data.world.sceneRotToLidar(rotation);

        var obj_cfg = globalObjectCategory.get_obj_cfg_by_type(obj_type);
        var scale = {   
            x: obj_cfg.size[0],
            y: obj_cfg.size[1],
            z: obj_cfg.size[2]
        };

        pos.z = -1.8 + scale.z/2;  // -1.8 is height of lidar

        let id = objIdManager.generateNewUniqueId();

        objIdManager.addObject({
            category: obj_type,
            id: id,
        });

        let box = this.add_box(pos, scale, rotation, obj_type, id);
        
        return box;
    };

    this.add_box= function(pos, scale, rotation, obj_type, obj_track_id, obj_attr){
        let box = this.data.world.annotation.add_box(pos, scale, rotation, obj_type, obj_track_id, obj_attr);

        this.floatLabelManager.add_label(box);
        
        this.imageContextManager.boxes_manager.add_box(box);

        this.selectBox(box);
        return box;
    };

    this.save_box_info= function(box){
        box.last_info = {
            //obj_type: box.obj_type,
            position: {
                x: box.position.x,
                y: box.position.y,
                z: box.position.z,
            },
            rotation: {
                x: box.rotation.x,
                y: box.rotation.y,
                z: box.rotation.z,
            },
            scale: {
                x: box.scale.x,
                y: box.scale.y,
                z: box.scale.z,
            }
        }
    };


    // axix, xyz, action: scale, move, direction, up/down
    this.transform_bbox= function(command){
        if (!this.selected_box)
            return;
        
        switch (command){
            case 'x_move_up':
                this.boxOp.translate_box(this.selected_box, 'x', 0.05);
                break;
            case 'x_move_down':
                this.boxOp.translate_box(this.selected_box, 'x', -0.05);
                break;
            case 'x_scale_up':
                this.selected_box.scale.x *= 1.01;    
                break;
            case 'x_scale_down':
                this.selected_box.scale.x /= 1.01;
                break;
            
            case 'y_move_up':
                this.boxOp.translate_box(this.selected_box, 'y', 0.05);
                break;
            case 'y_move_down':        
                this.boxOp.translate_box(this.selected_box, 'y', -0.05);            
                break;
            case 'y_scale_up':
                this.selected_box.scale.y *= 1.01;    
                break;
            case 'y_scale_down':
                this.selected_box.scale.y /= 1.01;
                break;
            
            case 'z_move_up':
                this.selected_box.position.z += 0.05;
                break;
            case 'z_move_down':        
                this.selected_box.position.z -= 0.05;
                break;
            case 'z_scale_up':
                this.selected_box.scale.z *= 1.01;    
                break;
            case 'z_scale_down':
                this.selected_box.scale.z /= 1.01;
                break;
            
            case 'z_rotate_left':
                this.selected_box.rotation.z += 0.01;
                break;
            case 'z_rotate_right':
                this.selected_box.rotation.z -= 0.01;
                break;
            
            case 'z_rotate_reverse':
                // 顺时针旋转车头 90 度，同时交换 scale.x / scale.y
                // 从而保持 box 在世界坐标下的几何位置和外形不变，仅调整朝向语义
                this.selected_box.rotation.z -= Math.PI / 2;
                {
                    const sx = this.selected_box.scale.x;
                    this.selected_box.scale.x = this.selected_box.scale.y;
                    this.selected_box.scale.y = sx;
                }
                break;
            case 'reset':
                this.selected_box.rotation.x = 0;
                this.selected_box.rotation.y = 0;
                this.selected_box.rotation.z = 0;
                this.selected_box.position.z = 0;
                break;

        }

        this.on_box_changed(this.selected_box);    
        
    };


    // function switch_bbox_type(target_type){
    //     if (!this.selected_box)
    //         return;

    //     if (!target_type){
    //         target_type = get_next_obj_type_name(this.selected_box.obj_type);
    //     }

    //     this.selected_box.obj_type = target_type;
    //     var obj_cfg = get_obj_cfg_by_type(target_type);
    //     this.selected_box.scale.x=obj_cfg.size[0];
    //     this.selected_box.scale.y=obj_cfg.size[1];
    //     this.selected_box.scale.z=obj_cfg.size[2];           

        
    //     this.floatLabelManager.set_object_type(this.selected_box.obj_local_id, this.selected_box.obj_type);
    //     this.floatLabelManager.update_label_editor(this.selected_box.obj_type, this.selected_box.obj_track_id);

        
        
    // }

    

    this.keydown= function( ev ) {

        // if (this.keydownDisabled)
        //     return;

        this.operation_state.key_pressed = true;

        // Ctrl+A: toggle frame select mode (select all boxes in current frame)
        if (ev.ctrlKey && !ev.shiftKey && (ev.key === 'a' || ev.key === 'A')){
            ev.preventDefault();
            this.toggleFrameSelectMode();
            return;
        }

        // Ctrl+Shift+C: copy all annotations in current frame
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'C' || ev.key === 'c')){
            ev.preventDefault();
            this.copyFrameAnnotations();
            return;
        }

        // Ctrl+Shift+V: paste annotations to current frame as initial annotations
        if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')){
            ev.preventDefault();
            this.pasteFrameAnnotations();
            return;
        }

        // In frame select mode, redirect movement/rotation keys to batch operations
        if (this.frame_select_state.active){
            const moveStep = this.editorCfg.moveStep || 0.02;
            const rotateStep = this.editorCfg.rotateStep || 0.01;
            // Use a larger absolute translation step for the group (in world/lidar coords)
            const groupMoveStep = 0.1;

            switch (ev.key){
                case 'w':
                    this.translateFrameBoxes('x', groupMoveStep);
                    return;
                case 's':
                    if (ev.ctrlKey){
                        saveWorldList(this.data.worldList);
                        return;
                    }
                    this.translateFrameBoxes('x', -groupMoveStep);
                    return;
                case 'a':
                    this.translateFrameBoxes('y', groupMoveStep);
                    return;
                case 'd':
                    this.translateFrameBoxes('y', -groupMoveStep);
                    return;
                case 'q':
                    this.rotateFrameBoxes(rotateStep);
                    return;
                case 'e':
                    this.rotateFrameBoxes(-rotateStep);
                    return;
                case 'Delete':
                    this.deleteFrameBoxes();
                    return;
                case 'Escape':
                    this.exitFrameSelectMode();
                    return;
                case '3':
                case 'PageUp':
                    // Exit frame select mode before switching frames (avoid stale references)
                    this.exitFrameSelectMode();
                    this.previous_frame();
                    return;
                case 'PageDown':
                case '4':
                    this.exitFrameSelectMode();
                    this.next_frame();
                    return;
                // For any other keys, exit frame select mode is not needed;
                // just fall through to normal handling but skip single-box shortcuts
            }
            // Ignore other keys while in frame select mode to prevent
            // accidentally editing an unselected single box.
            // Still allow Ctrl+S (save) which is caught in the outer switch below.
            if (!(ev.ctrlKey && (ev.key === 's' || ev.key === 'S'))){
                return;
            }
        }

        switch ( ev.key) {
            case '+':
            case '=':
                this.data.scale_point_size(1.2);
                this.render();
                break;
            case '-':
                this.data.scale_point_size(0.8);
                this.render();
                break;
            case '1': 
                this.select_previous_object();
                break;
            case '2':
                this.select_next_object();
                break;
            case '3':
            case 'PageUp':
                this.previous_frame();
                break;
            case 'PageDown':
            case '4':
                this.next_frame();
                break;
            case 'p':
                this.downloadWebglScreenShot();
                break;
            
            // case 'v':
            //     this.change_transform_control_view();
            //     break;
            /*
            case 'm':
            case 'M':
                smart_paste();
                break;
            case 'N':    
            case 'n':
                //add_bbox();
                //header.mark_changed_flag();
                break;        
            case 'B':
            case 'b':
                switch_bbox_type();
                self.header.mark_changed_flag();
                self.on_box_changed(this.selected_box);
                break;
            */
            case 'z': // X
                this.viewManager.mainView.transform_control.showX = ! this.viewManager.mainView.transform_control.showX;
                break;
            case 'x': // Y
                this.viewManager.mainView.transform_control.showY = ! this.viewManager.mainView.transform_control.showY;
                break;
            case 'c': // Z
                if (ev.ctrlKey){
                    this.mark_bbox(this.selected_box);
                } else {
                    this.viewManager.mainView.transform_control.showZ = ! this.viewManager.mainView.transform_control.showZ;
                }
                break;            
            case ' ': // Spacebar
                //this.viewManager.mainView.transform_control.enabled = ! this.viewManager.mainView.transform_control.enabled;
                this.playControl.pause_resume_play();
                break;
                
            case '5':            
            case '6':
            case '7':
                this.boxEditor.boxView.views[ev.key-5].cameraHelper.visible = !this.boxEditor.boxView.views[ev.key-5].cameraHelper.visible;
                this.render();
                break;
            
            
            case 's':
                    if (ev.ctrlKey){
                        saveWorldList(this.data.worldList);
                    }
                    else if (this.selected_box)
                    {
                        let v = Math.max(this.editorCfg.moveStep * this.selected_box.scale.x, 0.02);
                        this.boxOp.translate_box(this.selected_box, 'x', -v);
                        this.on_box_changed(this.selected_box);
                    }
                    break;
            case 'w':
                if (this.selected_box){
                    let v = Math.max(this.editorCfg.moveStep * this.selected_box.scale.x, 0.02);
                    this.boxOp.translate_box(this.selected_box, 'x', v);
                    this.on_box_changed(this.selected_box);                
                }
                break;
            case 'a':
                if (this.selected_box){
                    let v = Math.max(this.editorCfg.moveStep * this.selected_box.scale.y, 0.02);
                    this.boxOp.translate_box(this.selected_box, 'y', v);
                    this.on_box_changed(this.selected_box);                
                }
                break;
            case 'd':
                if (this.selected_box){
                    let v = Math.max(this.editorCfg.moveStep * this.selected_box.scale.y, 0.02);
                    this.boxOp.translate_box(this.selected_box, 'y', -v);
                    this.on_box_changed(this.selected_box);                
                }
                break;

            case 'q':
                if (this.selected_box){
                    this.boxOp.rotate_z(this.selected_box, this.editorCfg.rotateStep, false);
                    this.on_box_changed(this.selected_box);
                }
                break;
            case 'e':
                if (this.selected_box){
                    this.boxOp.rotate_z(this.selected_box, -this.editorCfg.rotateStep, false);
                    this.on_box_changed(this.selected_box);
                }
                break;
            case 'r':
                if (this.selected_box){
                    //this.transform_bbox("z_rotate_left");
                    this.boxOp.rotate_z(this.selected_box, this.editorCfg.rotateStep, true);
                    this.on_box_changed(this.selected_box);
                }
                break;
            
            case 'f':
                if (this.selected_box){                
                    //this.transform_bbox("z_rotate_right");                
                    this.boxOp.rotate_z(this.selected_box, -this.editorCfg.rotateStep, true);
                    this.on_box_changed(this.selected_box);
                }
                break;
            case 'g':
                this.transform_bbox("z_rotate_reverse");
                break;
            case 't':
                //this.transform_bbox("reset");
                this.showTrajectory();
                break;
            case 'v':
                this.enterBatchEditMode();
                break;
            case 'd':
            case 'D':
                if (ev.ctrlKey){
                    this.remove_selected_box();
                    this.header.updateModifiedStatus();    
                }
                break;
            case 'Delete':
                this.remove_selected_box();
                this.header.updateModifiedStatus();
                break;
            case 'Escape':
                if (this.frame_select_state.active){
                    this.exitFrameSelectMode();
                }
                else if (this.selected_box){
                    this.unselectBox(null);
                }
                break;
        }
    };

    // Frame selection mode functions
    this.enterFrameSelectMode = function(){
        if (!this.data.world || !this.data.world.annotation.boxes || this.data.world.annotation.boxes.length === 0){
            return;
        }

        // Exit single box selection mode
        if (this.selected_box){
            this.unselectBox(null);
        }

        this.frame_select_state.active = true;
        this.frame_select_state.selected_boxes = [...this.data.world.annotation.boxes];
        this.frame_select_state.original_colors = [];

        // Save original colors and highlight all boxes
        this.frame_select_state.selected_boxes.forEach(box => {
            this.frame_select_state.original_colors.push({
                r: box.material.color.r,
                g: box.material.color.g,
                b: box.material.color.b,
                opacity: box.material.opacity
            });
            box.material.color.set(0x00ffff); // Cyan color for frame selection
            box.material.opacity = 1.0;
        });

        this.render();
        logger.log(`Frame select mode: ${this.frame_select_state.selected_boxes.length} boxes selected`);
    };

    this.exitFrameSelectMode = function(){
        if (!this.frame_select_state.active){
            return;
        }

        // Restore original colors
        this.frame_select_state.selected_boxes.forEach((box, idx) => {
            if (this.frame_select_state.original_colors[idx]){
                let origColor = this.frame_select_state.original_colors[idx];
                box.material.color.setRGB(origColor.r, origColor.g, origColor.b);
                box.material.opacity = origColor.opacity;
            }
        });

        this.frame_select_state.active = false;
        this.frame_select_state.selected_boxes = [];
        this.frame_select_state.original_colors = [];

        this.render();
        logger.log("Frame select mode exited");
    };

    this.toggleFrameSelectMode = function(){
        if (this.frame_select_state.active){
            this.exitFrameSelectMode();
        } else {
            this.enterFrameSelectMode();
        }
    };

    // 整个 frame 做刚体平移/旋转会持续改变每个 box 覆盖到的点云，需要按类别色
    // 重新给这些 box 内的点云着色。为避免用户按住方向键时每帧都遍历所有点，做
    // 一个简单的 debounce：连按时合并到最后一次，只等空闲 ~60ms 再刷新。
    this._scheduleFrameBoxRecolor = function(){
        if (!this.data || !this.data.world || !this.data.world.lidar) return;
        if (typeof this.data.world.lidar.recolor_all_points !== "function") return;

        const world = this.data.world;
        if (this._frameRecolorTimer){
            clearTimeout(this._frameRecolorTimer);
        }
        this._frameRecolorTimer = setTimeout(() => {
            this._frameRecolorTimer = null;
            // world 可能在等待期间被切换，重新校验一下
            if (this.data && this.data.world === world && world.lidar){
                world.lidar.recolor_all_points();
                this.render();
            }
        }, 60);
    };

    // Translate all selected boxes in frame select mode (rigid body translation
    // in ego/lidar coordinates — every box moves by the same delta).
    this.translateFrameBoxes = function(axis, delta){
        if (!this.frame_select_state.active || this.frame_select_state.selected_boxes.length === 0){
            return;
        }

        // Directly translate in ego/lidar coordinates so the whole frame moves
        // as a rigid body. Do NOT use boxOp.translate_box here because that
        // applies the box's own rotation to the delta (box-local coordinates).
        this.frame_select_state.selected_boxes.forEach(box => {
            box.position[axis] += delta;
            // Update float label position for each box
            this.floatLabelManager.update_position(box, true);
        });

        this.frame_select_state.selected_boxes.forEach(box => {
            box.world.annotation.setModified();
        });

        this.header.updateModifiedStatus();
        this.render();

        // Box 已挪到新位置，落在框内的点云也跟着变了 —— 按 box 类别色重新着色。
        this._scheduleFrameBoxRecolor();
    };

    // Rotate all selected boxes around the ego origin (0,0,0) as a rigid body
    // (yaw only). Each box's position and yaw are rotated by the same theta.
    this.rotateFrameBoxes = function(theta){
        if (!this.frame_select_state.active || this.frame_select_state.selected_boxes.length === 0){
            return;
        }

        const cos_theta = Math.cos(theta);
        const sin_theta = Math.sin(theta);

        // Rigid body rotation around ego (lidar origin): each box's (x,y)
        // rotates around (0,0), and each box's yaw increments by theta.
        this.frame_select_state.selected_boxes.forEach(box => {
            const x = box.position.x;
            const y = box.position.y;
            box.position.x = x * cos_theta - y * sin_theta;
            box.position.y = x * sin_theta + y * cos_theta;
            box.rotation.z += theta;
            // Update float label position for each box
            this.floatLabelManager.update_position(box, true);
        });

        this.frame_select_state.selected_boxes.forEach(box => {
            box.world.annotation.setModified();
        });

        this.header.updateModifiedStatus();
        this.render();

        // Box 已旋转到新位置，同样需要按 box 类别色刷新点云颜色。
        this._scheduleFrameBoxRecolor();
    };

    // Delete all selected boxes in frame select mode
    this.deleteFrameBoxes = function(){
        if (!this.frame_select_state.active || this.frame_select_state.selected_boxes.length === 0){
            return;
        }

        const boxCount = this.frame_select_state.selected_boxes.length;
        
        // Make a copy of the list since we'll be modifying the world's box list
        const boxesToDelete = [...this.frame_select_state.selected_boxes];

        // Exit frame select mode first to clean up state
        this.exitFrameSelectMode();

        // Delete each box
        boxesToDelete.forEach(box => {
            this.do_remove_box(box, false);
        });

        this.header.updateModifiedStatus();
        this.render();
        
        logger.log(`Deleted ${boxCount} boxes from frame`);
    };

    // Copy frame annotations to clipboard (including track_id).
    // 同时记录源 scene/frame，粘贴时用于 odom 位姿对齐（若 odom 可用）。
    // 复制动作会顺便触发 scene 级 odom 数据的懒加载，这样等到粘贴时数据一般已就绪。
    this.copyFrameAnnotations = function(){
        if (!this.data.world || !this.data.world.annotation.boxes || this.data.world.annotation.boxes.length === 0){
            logger.log("No boxes to copy");
            return;
        }

        const srcScene = this.data.world.frameInfo.scene;
        const srcFrame = this.data.world.frameInfo.frame;

        this.frame_select_state.clipboard = {
            srcScene: srcScene,
            srcFrame: srcFrame,
            boxes: this.data.world.annotation.boxes.map(box => {
                return {
                    position: {x: box.position.x, y: box.position.y, z: box.position.z},
                    scale: {x: box.scale.x, y: box.scale.y, z: box.scale.z},
                    rotation: {x: box.rotation.x, y: box.rotation.y, z: box.rotation.z},
                    obj_type: box.obj_type,
                    obj_track_id: box.obj_track_id,
                    obj_attr: box.obj_attr
                };
            }),
        };

        // 提前拉取整段 clip 的 odom，粘贴时通常已经缓存好。
        // 失败或没 odom 也不影响复制本身。
        OdomManager.loadScene(srcScene).catch(() => {});

        logger.log(`Copied ${this.frame_select_state.clipboard.boxes.length} boxes to clipboard from ${srcScene}#${srcFrame}`);
    };


    // Paste frame annotations from clipboard. Preserves the original track_id
    // so users can continue tracking the same objects on the target frame.
    // If a box with the same track_id already exists on the target frame
    // (same id + same type), we replace it instead of adding a duplicate — this
    // keeps the paste idempotent and avoids invalid duplicate ids in one frame.
    //
    // 关键变化：如果源 clip 和当前 clip 都存在 odom.csv，就先按 frame 时间戳插值
    // 得到源帧和目标帧的 ego 世界位姿，再把 clipboard 里的 box（源帧 ego 系）通过
    // T_tgt<-src 变换到目标帧 ego 系，作为粘贴后的初始位姿。用户后续可继续用
    // frame-select 平移/旋转微调。
    //
    // 为避免等待网络阻塞用户，同一 scene 的 odom 已在 copyFrameAnnotations 时被
    // 预取，通常此刻已缓存。这里再 await 一次 loadScene（内部有缓存），即拿到就
    // 立刻用；拿不到（如没 odom.csv、或跨 clip 且新 clip 没同步）就退回原逻辑，
    // 直接用源帧 ego 系坐标粘贴。
    this.pasteFrameAnnotations = async function(){
        const clip = this.frame_select_state.clipboard;
        // 空 / 老格式（历史遗留 array）都判定为空
        if (!clip || !Array.isArray(clip.boxes) || clip.boxes.length === 0){
            logger.log("Clipboard is empty");
            return;
        }

        if (!this.data.world){
            return;
        }

        // If frame select mode is already active on this frame, exit it first
        // so the new pasted boxes get proper colors and there is no stale ref.
        if (this.frame_select_state.active){
            this.exitFrameSelectMode();
        }

        const world = this.data.world;
        const tgtScene = world.frameInfo.scene;
        const tgtFrame = world.frameInfo.frame;

        // 尝试构造 odom 变换。整个尝试过程出任何问题都退化为"直接粘贴原坐标"。
        let transformer = null;
        try {
            // 只有源和目标是同一个 scene 才有意义做变换：不同 clip 的 odom 坐标系
            // 起点不同，直接混用会得到错误结果。跨 clip 时直接跳过 odom 变换。
            if (clip.srcScene && clip.srcScene === tgtScene){
                // 保证两端 poses 都已加载。同一 scene 只会拉一次。
                const poses = await OdomManager.loadScene(clip.srcScene);
                if (poses && poses.length > 0){
                    const srcPose = OdomManager.getPoseForFrame(clip.srcScene, clip.srcFrame);
                    const tgtPose = OdomManager.getPoseForFrame(tgtScene, tgtFrame);
                    if (srcPose && tgtPose){
                        transformer = OdomManager.makeTransformer(srcPose, tgtPose);
                    }
                }
            }
        } catch (e) {
            console.warn("[odom-paste] transform build failed, fallback to raw paste", e);
            transformer = null;
        }

        if (transformer){
            const dx = transformer.translation.x, dy = transformer.translation.y;
            const dyawDeg = (transformer.dyaw * 180 / Math.PI).toFixed(2);
            logger.log(`Odom-aligned paste: src=${clip.srcScene}#${clip.srcFrame} → tgt=${tgtScene}#${tgtFrame}, `
                     + `dx=${dx.toFixed(2)}m dy=${dy.toFixed(2)}m dyaw=${dyawDeg}°`);
        } else if (clip.srcScene !== tgtScene){
            logger.log(`Paste across scenes (${clip.srcScene} → ${tgtScene}): odom alignment skipped.`);
        } else {
            logger.log("Odom data unavailable; paste with raw coordinates.");
        }

        let addedBoxes = [];

        clip.boxes.forEach(clipBox => {
            // 计算目标帧坐标：有 transformer 就用它变换，否则原样
            let tgtPos, tgtRotZ;
            if (transformer){
                tgtPos = transformer.applyPosition(clipBox.position);
                tgtRotZ = transformer.applyYawZ(clipBox.rotation.z || 0);
            } else {
                tgtPos = { x: clipBox.position.x, y: clipBox.position.y, z: clipBox.position.z };
                tgtRotZ = clipBox.rotation.z || 0;
            }
            const tgtRotation = {
                x: clipBox.rotation.x || 0,
                y: clipBox.rotation.y || 0,
                z: tgtRotZ,
            };

            // If a box with the same track_id + obj_type already exists, remove it
            // first so paste effectively overwrites duplicates on this frame.
            if (clipBox.obj_track_id !== undefined && clipBox.obj_track_id !== null
                && String(clipBox.obj_track_id).trim() !== "")
            {
                const existing = world.annotation.boxes.find(b =>
                    String(b.obj_track_id).trim() === String(clipBox.obj_track_id).trim()
                    && b.obj_type === clipBox.obj_type
                );
                if (existing){
                    world.annotation.unload_box(existing);
                    world.annotation.remove_box(existing);
                    this.floatLabelManager.remove_box(existing);
                    this.imageContextManager.boxes_manager.remove_box(existing.obj_local_id);
                }
            }

            let newBox = world.annotation.add_box(
                tgtPos,
                clipBox.scale,
                tgtRotation,
                clipBox.obj_type,
                clipBox.obj_track_id,  // preserve original track_id
                clipBox.obj_attr
            );

            this.floatLabelManager.add_label(newBox);
            this.imageContextManager.boxes_manager.add_box(newBox);

            // Register the id with the object manager so it shows up in the
            // clip-wide id list (and so track_id-uniqueness checks work).
            if (clipBox.obj_track_id !== undefined && clipBox.obj_track_id !== null
                && String(clipBox.obj_track_id).trim() !== "")
            {
                objIdManager.addObject({
                    category: newBox.obj_type,
                    id: newBox.obj_track_id,
                });
            }

            addedBoxes.push(newBox);
        });

        world.annotation.setModified();
        this.header.updateModifiedStatus();

        // 粘贴 + odom 对齐可能改变了 box 的位置/朝向，因此这些 box 现在覆盖到的点云
        // 需要按 box 类别色重新着色（走 lidar.color_objects()，使用 get_color_by_category
        // 而不是当前 material.color，所以即使进入 frame select 后 box 边线变青，
        // 点云依然显示为类别色）。
        if (world.lidar && typeof world.lidar.recolor_all_points === "function"){
            world.lidar.recolor_all_points();
        }

        this.render();

        logger.log(`Pasted ${addedBoxes.length} boxes from clipboard (track_id preserved)`);

        // Auto-enter frame select mode for the pasted boxes so the user can
        // immediately move/rotate them as a rigid group.
        if (addedBoxes.length > 0){
            this.frame_select_state.active = true;
            this.frame_select_state.selected_boxes = addedBoxes;
            this.frame_select_state.original_colors = [];

            addedBoxes.forEach(box => {
                this.frame_select_state.original_colors.push({
                    r: box.material.color.r,
                    g: box.material.color.g,
                    b: box.material.color.b,
                    opacity: box.material.opacity
                });
                box.material.color.set(0x00ffff);
                box.material.opacity = 1.0;
            });

            this.render();
            logger.log("Frame select mode activated for pasted boxes");
        }
    };




    this.previous_frame= function(){



        if (!this.data.meta)
            return;

        var scene_meta = this.data.get_current_world_scene_meta();

        var frame_index = this.data.world.frameInfo.frame_index-1;

        if (frame_index < 0){
            console.log("first frame");
            this.infoBox.show("Notice", "This is the first frame");
            return;
        }

        this.load_world(scene_meta.scene, scene_meta.frames[frame_index]);

        

    };

    this.last_frame = function()
    {
        let scene_meta = this.data.get_current_world_scene_meta();
        this.load_world(scene_meta.scene, scene_meta.frames[scene_meta.frames.length-1]);
    };
    this.first_frame = function()
    {
        let scene_meta = this.data.get_current_world_scene_meta();
        this.load_world(scene_meta.scene, scene_meta.frames[0]);
    };

    this.next_frame= function(){    



        if (!this.data.meta)
            return;
            
        var scene_meta = this.data.get_current_world_scene_meta();

        var num_frames = scene_meta.frames.length;

        var frame_index = (this.data.world.frameInfo.frame_index +1);

        if (frame_index >= num_frames){
            console.log("last frame");
            this.infoBox.show("Notice", "This is the last frame");
            return;
        }

        this.load_world(scene_meta.scene, scene_meta.frames[frame_index]);
    };

    this.select_next_object= function(){

        var self=this;
        if (this.data.world.annotation.boxes.length<=0)
            return;

        if (this.selected_box){
            this.operation_state.box_navigate_index = this.data.world.annotation.boxes.findIndex(function(x){
                return self.selected_box == x;
            });
        }
        
        this.operation_state.box_navigate_index += 1;            
        this.operation_state.box_navigate_index %= this.data.world.annotation.boxes.length;    
        
        this.selectBox(this.data.world.annotation.boxes[this.operation_state.box_navigate_index]);

    };

    this.select_previous_object= function(){
        var self=this;
        if (this.data.world.annotation.boxes.length<=0)
            return;

        if (this.selected_box){
            this.operation_state.box_navigate_index = this.data.world.annotation.boxes.findIndex(function(x){
                return self.selected_box == x;
            });
        }
        
        this.operation_state.box_navigate_index += this.data.world.annotation.boxes.length-1;            
        this.operation_state.box_navigate_index %= this.data.world.annotation.boxes.length;    
        
        this.selectBox(this.data.world.annotation.boxes[this.operation_state.box_navigate_index]);
    };

    // this.centerMainView =function(){
    //     let offset = this.data.world.coordinatesOffset;
    //     this.viewManager.mainView.orbit.target.x += offset[0];
    //     this.viewManager.mainView.orbit.target.y += offset[1];
    //     this.viewManager.mainView.orbit.target.z += offset[2];        
    // };

    this.on_load_world_finished= function(world){

        document.title = "SUSTech POINTS-" + world.frameInfo.scene;
        // switch view positoin
        this.moveAxisHelper(world);
        this.moveRangeCircle(world);
        this.lookAtWorld(world);
        this.unselectBox(null, true);
        this.unselectBox(null, true);
        this.render();
        this.imageContextManager.attachWorld(world);
        this.imageContextManager.render_2d_image();
        this.render2dLabels(world);
        this.update_frame_info(world.frameInfo.scene, world.frameInfo.frame);

        this.select_locked_object();
        
        //load_obj_ids_of_scene(world.frameInfo.scene);
        objIdManager.setCurrentScene(world.frameInfo.scene);

        // preload after the first world loaded
        // otherwise the loading of the first world would be too slow
        this.data.preloadScene(world.frameInfo.scene, world);
    };
    this.moveAxisHelper = function(world) {
        world.webglGroup.add(this.axis);
    };

    this.mainViewOffset = [0,0,0];

    this.lookAtWorld = function(world){
        let newOffset = [
                world.coordinatesOffset[0] - this.mainViewOffset[0],
                world.coordinatesOffset[1] - this.mainViewOffset[1],
                world.coordinatesOffset[2] - this.mainViewOffset[2],
            ];
        
        this.mainViewOffset = world.coordinatesOffset;
        
        this.viewManager.mainView.orbit.target.x += newOffset[0];
        this.viewManager.mainView.orbit.target.y += newOffset[1];
        this.viewManager.mainView.orbit.target.z += newOffset[2];

        this.viewManager.mainView.camera.position.x += newOffset[0];
        this.viewManager.mainView.camera.position.y += newOffset[1];
        this.viewManager.mainView.camera.position.z += newOffset[2];

        this.viewManager.mainView.orbit.update();
        
    };

    this.load_world = async function(sceneName, frame, onFinished){

        this.data.dbg.dump();

        logger.log(`load ${sceneName}, ${frame}`);

        // If we are in frame select mode, exit before loading a new frame so we
        // don't hold stale references to the old world's boxes.
        if (this.frame_select_state.active){
            this.exitFrameSelectMode();
        }

        var self=this;
        //stop if current world is not ready!
        if (this.data.world && !this.data.world.preloaded()){
            console.error("current world is still loading.");
            return;
        }

        if (this.selected_box && this.selected_box.in_highlight){
            this.cancelFocus(this.selected_box);
        }

        if (this.viewManager.mainView && this.viewManager.mainView.transform_control.visible)
        {
            //unselect first time
            this.viewManager.mainView.transform_control.detach();
        }

        var world = await this.data.getWorld(sceneName, frame);

        if (world)
        {
            this.data.activate_world(
                world, 
                function(){
                    self.on_load_world_finished(world);
                    if (onFinished)
                        onFinished();
                    
                }
            );
        }

        
    };


    this.remove_box = function(box, render=true){
        if (box === this.selected_box){
            this.unselectBox(null,true);
            this.unselectBox(null,true); //twice to safely unselect.
            this.selected_box = null;
            //this.remove_selected_box();
        } 
        


        this.do_remove_box(box, false); // render later.

        // this should be after do-remove-box
        // subview renderings don't need to be done again after
        // the box is removed.
        if (box.boxEditor)
        {
            if (box.boxEditor){
                box.boxEditor.detach("donthide");
            }
            else{
                console.error("what?");
            }
        }


        this.header.updateModifiedStatus();

        if (render)
            this.render();
        
    };

    this.remove_selected_box= function(){
        this.remove_box(this.selected_box);
    };

    this.do_remove_box = function(box, render=true){

        if (!box.annotator)
            this.restore_box_points_color(box, render);

        this.imageContextManager.boxes_manager.remove_box(box.obj_local_id);

        this.floatLabelManager.remove_box(box);
        this.fastToolBox.hide();
                    
        //this.selected_box.dispose();
        
        box.world.annotation.unload_box(box);
        box.world.annotation.remove_box(box);

        box.world.annotation.setModified();
    },

    this.clear= function(){

        this.header.clear_box_info();
        //this.editorUi.querySelector("#image").innerHTML = '';
        
        this.unselectBox(null);
        this.unselectBox(null);

        this.header.clear_frame_info();

        this.imageContextManager.clear_main_canvas();
        this.boxEditor.detach();


        this.data.world.unload();
        this.data.world= null; //dump it
        this.floatLabelManager.remove_all_labels();
        this.fastToolBox.hide();
        this.render();
    };

    this.update_frame_info= function(scene, frame){
        var self = this;
        this.header.set_frame_info(scene, frame, function(sceneName){
            self.scene_changed(sceneName)});
    };

    //box edited
    this.on_box_changed = function(box){

        if (!this.imageContextManager.hidden())
            this.imageContextManager.boxes_manager.update_box(box);

        this.header.update_box_info(box);
        this.floatLabelManager.update_position(box, true);  // Update label position when box changes
        
        box.world.annotation.setModified();
        
        

        this.updateBoxPointsColor(box);
        this.save_box_info(box);
        
        

        if (box.boxEditor){
            box.boxEditor.onBoxChanged();
        }
        else{
            console.error("what?");
        }

        this.autoAdjust.syncFollowers(box);

        // if (box === this.data.world.radar_box){
        //     this.data.world.move_radar(box);
        // }

        if (box.on_box_changed){
            box.on_box_changed();
        }

        this.header.updateModifiedStatus();
        this.render();
    };

    // box removed, restore points color.
    this.restore_box_points_color= function(box,render=true){
        if (this.data.cfg.color_obj != "no"){
            box.world.lidar.reset_box_points_color(box);
            box.world.lidar.update_points_color();
            if (render)
                this.render();
        }
        
    };

    this.updateBoxPointsColor= function(box){
        if (this.data.cfg.color_obj != "no"){
            if (box.last_info){
                box.world.lidar.set_box_points_color(box.last_info, {x: this.data.cfg.point_brightness, y: this.data.cfg.point_brightness, z: this.data.cfg.point_brightness});
            }

            box.world.lidar.set_box_points_color(box);
            box.world.lidar.update_points_color();            
        }
    };

    this.onSelectedBoxChanged= function(box){

        if (box){        
            this.header.update_box_info(box);
            // this.floatLabelManager.update_position(box, true);
            // this.fastToolBox.setPos(this.floatLabelManager.getLabelEditorPos(box.obj_local_id));
            this.imageContextManager.boxes_manager.onBoxSelected(box.obj_local_id, box.obj_type);


            //this.boxEditor.attachBox(box);

            this.render();
            //this.boxEditor.boxView.render();

            //this.updateSubviewRangeByWindowResize(box);
            
        } else {
            this.header.clear_box_info();
        }

    };

    this.render2dLabels= function(world){
        if (this.editorCfg.disableMainView)
            return;

        this.floatLabelManager.remove_all_labels();
        var self=this;
        world.annotation.boxes.forEach(function(b){
            self.floatLabelManager.add_label(b);
        })

        if (this.selected_box){
            //this.floatLabelManager.select_box(this.selected_box.obj_local_id)
            this.fastToolBox.show();
            this.fastToolBox.setValue(this.selected_box.obj_type, this.selected_box.obj_track_id, this.selected_box.obj_attr);
        }
    };

    this.add_global_obj_type= function(){

        var self = this;
        var sheet = window.document.styleSheets[1];

        let obj_type_map = globalObjectCategory.obj_type_map;

        for (var o in obj_type_map){
            var rule = '.'+o+ '{color:'+obj_type_map[o].color+';'+ 
                                'stroke:' +obj_type_map[o].color+ ';'+
                                'fill:' +obj_type_map[o].color+ '22' + ';'+
                                '}';
            sheet.insertRule(rule, sheet.cssRules.length);
        }

        function color_str(v){
            let c =  Math.round(v*255);
            if (c < 16)
                return "0" + c.toString(16);
            else
                return c.toString(16);
        }

        for (let idx=0; idx<=32; idx++){
            let c = globalObjectCategory.get_color_by_id(idx);
            let color = "#" + color_str(c.x) + color_str(c.y) + color_str(c.z);

            var rule = '.color-'+idx+ '{color:'+color+';'+ 
                                'stroke:' +color+ ';'+
                                'fill:' +color+ '22' + ';'+
                                '}';
            sheet.insertRule(rule, sheet.cssRules.length);
        }

        // obj type selector
        var options = "";
        for (var o in obj_type_map){
            options += '<option value="'+o+'" class="' +o+ '">'+o+ '</option>';        
        }

        this.editorUi.querySelector("#floating-things #object-category-selector").innerHTML = options;
        //this.editorUi.querySelector("#batch-editor-tools-wrapper #object-category-selector").innerHTML = options;

        // submenu of new
        var items = "";
        for (var o in obj_type_map){
            items += '<div class="menu-item cm-new-item ' + o + '" id="cm-new-'+o+'" uservalue="' +o+ '"><div class="menu-item-text">'+o+ '</div></div>';        
        }

        this.editorUi.querySelector("#new-submenu").innerHTML = items;

        this.contextMenu.installMenu("newSubMenu", this.editorUi.querySelector("#new-submenu"), (event)=>{
            let obj_type = event.currentTarget.getAttribute("uservalue");
            let box = self.add_box_on_mouse_pos(obj_type);
            //switch_bbox_type(event.currentTarget.getAttribute("uservalue"));
            //self.boxOp.grow_box(box, 0.2, {x:2, y:2, z:3});
            //self.auto_shrink_box(box);
            //self.on_box_changed(box);

            let noscaling = event.shiftKey;

            self.boxOp.auto_rotate_xyz(box, null, null, function(b){
                self.on_box_changed(b);
            }, noscaling);
            return true;
        });

        // // install click actions
        // for (var o in obj_type_map){        
        //     this.editorUi.querySelector("#cm-new-"+o).onclick = (event)=>{

        //         // hide context men
        //         // let context menu object handle this.
        //         // this.editorUi.querySelector("#context-menu-wrapper").style.display="none";

        //         // process event
        //         var obj_type = event.currentTarget.getAttribute("uservalue");
        //         let box = self.add_box_on_mouse_pos(obj_type);
        //         //switch_bbox_type(event.currentTarget.getAttribute("uservalue"));
        //         //self.boxOp.grow_box(box, 0.2, {x:2, y:2, z:3});
        //         //self.auto_shrink_box(box);
        //         //self.on_box_changed(box);

        //         self.boxOp.auto_rotate_xyz(box, null, null, function(b){
        //             self.on_box_changed(b);
        //         });
                
        //     }
        // }

    };

    this.interpolate_selected_object= function(){

        let scene = this.data.world.frameInfo.scene; 
        let frame = this.data.world.frameInfo.frame;
        let obj_id = this.selected_box.obj_track_id;

        this.boxOp.interpolate_selected_object(scene, obj_id, frame, (s,fs)=>{
            this.onAnnotationUpdatedByOthers(s, fs);
        });

        
    };

    this.onAnnotationUpdatedByOthers = function(scene, frames){
        this.data.onAnnotationUpdatedByOthers(scene, frames);
    }

    this.init(editorUi);

};

export{Editor}