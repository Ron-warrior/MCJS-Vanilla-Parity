import {activeGLSL} from './glsl-preprocessor.js';
import {glslImplicitFloat} from './glsl-functions.js';
// Desktop GLSL permits uniform-dependent global initializers; GLSL ES does not.
// Move their assignments into a function called at fragment entry, preserving
// preprocessor branches and declaration order. The GPU still compiles all GLSL.
export function deferredShaderGlobals(source){
  const init=[];let depth=0;
  const clean=source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,text=>text.replace(/[^\n]/g,' ')).split('\n');
  const raw=source.split('\n'),continuedTo=new Array(raw.length).fill(false);
  {let cont=false;for(let i=0;i<raw.length;i++){continuedTo[i]=cont;const m=raw[i].match(/(\\+)$/);cont=!!m&&m[1].length%2===1;}}
  const lines=raw.map((line,index)=>{
    const code=clean[index];
    if(/^[ \t]*#(?:if|ifdef|ifndef|elif|else|endif)\b/.test(code)){init.push(code);return line;}
    const declaration=!depth&&!continuedTo[index]&&/^[ \t]*((?:(?:lowp|mediump|highp)\s+)?(?:float|int|bool|[biu]?vec[234]|mat[234]))\s+(\w+)\s*=\s*(.+);\s*$/.exec(code);
    if(declaration){init.push(declaration[2]+' = '+declaration[3]+';');return declaration[1]+' '+declaration[2]+';';}
    if(!continuedTo[index]&&!/^[ \t]*#/.test(code))depth+=(code.match(/{/g)||[]).length-(code.match(/}/g)||[]).length;
    return line;
  });
  if(!init.some(line=>line.includes(' = ')))return source;
  return 'void mcjsInitGlobals();\n'+lines.join('\n').replace(/void\s+main\s*\(\s*\)\s*{/g,'void main(){mcjsInitGlobals();')+'\nvoid mcjsInitGlobals(){\n'+init.join('\n')+'\n}\n';
}
export function shaderCompatibility(zip,root){
  if(zip.has(root+'shaders.settings'))return {kind:'sildur',disabled:['TAA','Depth_of_Field','Motionblur','Distance_Blur','smoothDof','DoF_Strength','Dof_Distance_View','MB_strength'],fixed:{Showbuffer:'0'}};
  if(zip.has(root+'settings/globalSettings.glsl')&&zip.has(root+'lib/vertex/waving.glsl'))return {kind:'astra',disabled:['DISTORTION','ARC_EN_CIEL','BARREL'],fixed:{}};
  return {kind:'bsl',disabled:[],fixed:{}};
}
export function compatibleShaderSource(source,profile,version=11502){
  const disabled=new Set(profile.disabled);
  source=source.replace(/^[ \t]*#define\s+(\w+)\b([^\n]*)/gm,(line,name)=>disabled.has(name)?'#undef '+name:profile.fixed[name]!==undefined?'#define '+name+' '+profile.fixed[name]:line);
  source=activeGLSL(source,{MC_VERSION:String(version)});
  source=glslImplicitFloat(source);
  source=source.replace(/\b(worldTime|isEyeInWater)\s*([*/])\s*(\d+\.\d*)/g,'float($1) $2 $3').replace(/\beyeBrightnessSmooth\.([xy])\b/g,'float(eyeBrightnessSmooth.$1)');
  source=source.replace(/(float\([^()]*\))[ \t]*([+*/-])[ \t]*(\d+)(?![\w.])/g,'$1 $2 $3.0');
  return deferredShaderGlobals(source);
}
