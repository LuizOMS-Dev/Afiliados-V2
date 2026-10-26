'use strict';
const THEMES=Object.freeze([
 {id:'esmeralda',name:'Esmeralda Claro',description:'Verde discreto, fundo claro e textos escuros.',mode:'light'},
 {id:'oceano',name:'Azul Oceano',description:'Azul profundo, branco suave e excelente legibilidade.',mode:'light'},
 {id:'areia',name:'Areia e Terracota',description:'Tons quentes, fundo creme e detalhes em cobre.',mode:'light'},
 {id:'safira',name:'Noite Safira',description:'Azul-marinho, cartões escuros e textos claros.',mode:'dark'},
 {id:'grafite',name:'Grafite e Turquesa',description:'Cinza profundo com detalhes em turquesa.',mode:'dark'},
 {id:'ameixa',name:'Ameixa e Dourado',description:'Roxo escuro, acentos dourados e visual elegante.',mode:'dark'}
]);
const DEFAULT_THEME='esmeralda';
const THEME_IDS=Object.freeze(THEMES.map(x=>x.id));
function validateTheme(raw){
 const id=String(raw??'').trim();
 if(!THEME_IDS.includes(id))throw Error('Escolha um dos seis temas disponíveis.');
 return id;
}
function effectiveTheme(value){
 return THEME_IDS.includes(value)?value:DEFAULT_THEME;
}
module.exports={THEMES,THEME_IDS,DEFAULT_THEME,validateTheme,effectiveTheme};
