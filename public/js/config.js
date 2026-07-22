
class Config{

    //dataCfg = {
    
    //disableLabels: true,
    enablePreload = true;
    color_points = "mono";
    enableRadar = false;
    enableAuxLidar = false;
    enableDynamicGroundLevel = true;

    coordinateSystem = 'utm';

    // 主界面默认点云大小 (按用户当前页面设定值)
    point_size = 1.15;
    // 主界面默认点云亮度 (按用户当前页面设定值；超过 1 的部分会被 shader clamp 到最大亮度)
    point_brightness = 1.6;
    box_opacity = 1;
    show_background = true;
    color_obj = "category";
    theme = "dark";

    enableFilterPoints = true;
    filterPointsMaxZ = 2.0;  // 显示点云的最大 Z 值，超过此值的点云不加载显示
    filterPointsMinZ = -5.0; // 显示点云的最小 Z 值，低于此值的点云不加载显示

    batchModeInstNumber = 20;
    batchModeSubviewSize = {width: 130, height: 450};


    // edit on one box, apply to all selected boxes.
    linkEditorsInBatchMode = false;

    // only rotate z in 'auto/interpolate' algs
    enableAutoRotateXY = false;
    autoSave = true;

    autoUpdateInterpolatedBoxes = true;

    hideId = false;
    hideCategory = false;

    moveStep = 0.01;  // ratio, percentage
    rotateStep = Math.PI/360;
    
    ignoreDistantObject = true;
    
    ///editorCfg

    //disableSceneSelector = true;
    //disableFrameSelector = true;
    //disableCameraSelector = true;
    //disableFastToolbox= true;
    //disableMainView= true;
    //disableMainImageContext = true;
    //disableGrid = true;
    //disableRangeCircle = true;
    //disableAxis = true;
    //disableMainViewKeyDown = true;
    //projectRadarToImage = true;
    //projectLidarToImage = true;   

    constructor()
    {
        
    }

    readItem(name, defaultValue, castFunc){
        let ret = window.localStorage.getItem(name);
        
        if (ret)
        {
            if (castFunc)
                return castFunc(ret);
            else
                return ret;
        }
        else
        {
            return defaultValue;
        }        
    }

    setItem(name, value)
    {
        this[name] = value;
        if (typeof value == 'object')
            value = JSON.stringify(value);
        window.localStorage.setItem(name, value);
    }

    toBool(v)
    {
        return v==="true";
    }

    saveItems = [
        ["theme", null],
        ["enableRadar", this.toBool],
        ["enablePreload", this.toBool],
        ["enableAuxLidar", this.toBool],
        ["enableFilterPoints", this.toBool],
        ["filterPointsMaxZ", parseFloat],
        ["filterPointsMinZ", parseFloat],
        ["color_points", null],
        ["coordinateSystem", null],
        ["batchModeInstNumber", parseInt],
        ["batchModeSubviewSize", JSON.parse],
        ["enableAutoRotateXY", this.toBool],
        ["autoUpdateInterpolatedBoxes", this.toBool],
    ];

    load()
    {
        this.saveItems.forEach(item=>{
            let key = item[0];
            let castFunc = item[1];

            this[key] = this.readItem(key, this[key], castFunc);
        })
    }
};

export {Config};