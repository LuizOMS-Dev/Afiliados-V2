'use strict';
const {ICONS}=require('./sidebar-nav');
const {effectiveTheme}=require('./ui-themes');
function esc(value){
 return String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function renderLogin({next='/admin',error='',unavailable=false,brand={}}={}){
 const siteName=esc(brand.site_name||'Central de Afiliados');
 const upperName=esc((brand.site_name||'Central de Afiliados').toLocaleUpperCase('pt-BR'));
 const logo=brand.has_logo?'<img class="login-logo" src="/brand/logo.png?v='+Number(brand.version||0)+'" alt="'+siteName+'">':'<div class="brand-mark">CA<span class="brand-mark-dot"></span></div>';
 const favicon=brand.has_favicon?'<link rel="icon" type="image/png" href="/brand/favicon.png?v='+Number(brand.version||0)+'">':'';
 const feedback=error?'<div class="login-alert" role="alert">'+esc(error)+'</div>':'';
 return '<!doctype html><html lang="pt-BR" data-theme="'+effectiveTheme(brand.theme_id)+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar | '+siteName+'</title>'+favicon+'<link rel="stylesheet" href="/login.css?v=40"><link rel="stylesheet" href="/themes.css?v=1&rev=40"></head>'+
 '<body class="login-body"><main class="login-layout">'+
 '<section class="login-brand-panel" aria-label="'+siteName+'">'+logo+'<div class="brand-intro"><span class="brand-overline">'+upperName+'</span><h1>Suas ofertas.<br>Novas possibilidades.</h1><p>Um único lugar para gerenciar produtos, conexões e a programação de publicações.</p><div class="brand-flow"><span>'+ICONS.products+'Catálogo</span><span>'+ICONS.plan+'Programação</span><span>'+ICONS.clicks+'Resultados</span></div></div><div class="brand-bottom">Área de gerenciamento • Acesso autorizado</div></section>'+
 '<section class="login-form-panel"><div class="login-card"><div class="login-mobile-brand">'+(brand.has_logo?'<img src="/brand/logo.png?v='+Number(brand.version||0)+'" alt="'+siteName+'">':siteName)+'</div><div class="login-heading"><span class="login-eyebrow">BEM-VINDO DE VOLTA</span><h2>Acesse sua conta</h2><p>Entre com o usuário e a senha já cadastrados na Central.</p></div>'+feedback+
 '<form class="login-form" method="post" action="/login" autocomplete="on"><input type="hidden" name="next" value="'+esc(next)+'"><label for="login-user">Usuário</label><input id="login-user" name="username" type="text" maxlength="200" autocomplete="username" spellcheck="false" autocapitalize="none" placeholder="Digite seu usuário" required autofocus>'+
 '<label for="login-password">Senha</label><input id="login-password" name="password" type="password" maxlength="1000" autocomplete="current-password" placeholder="Digite sua senha" required><button class="login-submit" type="submit"'+(unavailable?' disabled':'')+'>Entrar na Central <span aria-hidden="true">→</span></button></form>'+
 '<div class="login-footer"><span class="login-lock" aria-hidden="true">●</span> Ambiente de acesso restrito</div></div><div class="form-bottom">'+siteName+'</div></section></main></body></html>';
}
module.exports={renderLogin};

