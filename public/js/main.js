import{Config} from "./config.js"
import{Editor} from "./editor.js"
import {Data} from './data.js'


let pointsGlobalConfig = new Config();
window.pointsGlobalConfig = pointsGlobalConfig;


pointsGlobalConfig.load();


// Preload classify_config.json so that "by classify" color mode works
// independently of activating the classify annotation mode.
// Populates window.classifyClassMap early during page bootstrap.
window.classifyClassMapReady = (async () => {
  try {
    const resp = await fetch('/static/classify_config.json');

    if (!resp.ok) return;
    const cfg = await resp.json();
    if (Array.isArray(cfg.classify_classes)) {
      const classMap = {};
      cfg.classify_classes.forEach(cls => {
        if (Array.isArray(cls.color) && cls.color.length >= 3) {
          classMap[cls.value] = [cls.color[0], cls.color[1], cls.color[2]];
        }
      });
      window.classifyClassMap = classMap;

      // If the user already had "by classify" selected (persisted config),
      // refresh coloring across loaded worlds now that the palette is ready.
      if (window.editor && pointsGlobalConfig.color_points === 'classify'){
        try {
          window.editor.data.worldList.forEach(w => {
            if (w.lidar && w.lidar.color_points){
              w.lidar.color_points();
              w.lidar.update_points_color();
            }
          });
          window.editor.render();
        } catch(e) { /* editor not fully ready yet, ignore */ }
      }
    }
  } catch (e) {
    console.warn('Failed to preload classify_config.json:', e);
  }
})();



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

