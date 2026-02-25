import{Config} from "./config.js"
import{Editor} from "./editor.js"
import {Data} from './data.js'


let pointsGlobalConfig = new Config();
window.pointsGlobalConfig = pointsGlobalConfig;


pointsGlobalConfig.load();

// Global classify configuration
let classifyConfig = null;
window.getClassifyConfig = async function() {
    if (classifyConfig) return classifyConfig;

    try {
        const response = await fetch('/static/config/classify_config.json');
        classifyConfig = await response.json();
        window.classifyConfig = classifyConfig;
        return classifyConfig;
    } catch (e) {
        console.warn('Failed to load classify_config.json, using defaults:', e);
        // Default fallback
        classifyConfig = {
            classify_classes: [
                { value: 0, name: "未分类", color: [1.0, 1.0, 1.0] },
                { value: 1, name: "地面", color: [0.0, 1.0, 0.0] },
                { value: 2, name: "障碍物", color: [1.0, 0.0, 0.0] },
                { value: 3, name: "大车", color: [0.0, 0.0, 1.0] },
                { value: 4, name: "小车", color: [0.0, 1.0, 1.0] },
                { value: 5, name: "VRU", color: [1.0, 0.0, 1.0] },
                { value: 6, name: "行人", color: [1.0, 0.5, 0.0] }
            ]
        };
        window.classifyConfig = classifyConfig;
        return classifyConfig;
    }
};

// Get classify colors as a simple map {value: [r, g, b]}
window.getClassifyColors = function() {
    if (!classifyConfig) return null;
    const colors = {};
    for (const cls of classifyConfig.classify_classes) {
        colors[cls.value] = cls.color;
    }
    return colors;
};

// Preload classify config
window.getClassifyConfig();


document.documentElement.className="theme-"+pointsGlobalConfig.theme;


document.body.addEventListener('keydown', event => {
    if (event.ctrlKey && 'asdv'.indexOf(event.key) !== -1) {
      event.preventDefault()
    }
});

async function createMainEditor(){

  let template = document.querySelector('#editor-template');
  let maindiv  = document.querySelector("#main-editor");
  let main_ui = template.content.cloneNode(true);
  maindiv.appendChild(main_ui); // input parameter is changed after `append`

  let editorCfg = pointsGlobalConfig;

  let dataCfg = pointsGlobalConfig;
  
  let data = new Data(dataCfg);
  await data.init();

  let editor = new Editor(maindiv.lastElementChild, maindiv, editorCfg, data, "main-editor")
  window.editor = editor;
  editor.run();
  return editor;
} 

async function start(){

 
  let mainEditor = await createMainEditor();


  let url_string = window.location.href
  let url = new URL(url_string);
  //language
  let scene = url.searchParams.get("scene");
  let frame = url.searchParams.get("frame");

  if (scene && frame)
  {
    mainEditor.load_world(scene, frame);
  }
}




start();

