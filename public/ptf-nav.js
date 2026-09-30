// Общая навигация сайта и мини-приложений: значки вкладок и подписи.
//
// Значки — тонкие линейные, рисуются цветом текста вкладки (currentColor):
// на активной вкладке они сами становятся янтарными, на светлой теме —
// зелёными. Одинаково выглядят на любом телефоне и компьютере, в отличие от
// эмодзи. Подключается и витриной лиги, и экраном «Мои матчи», чтобы меню в
// обоих местах было одно и то же.
(function(w){
  var P={
    home:'<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11.5h13V9"/><path d="M10 20.5v-6h4v6"/>',
    div:'<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.8h17M9 4v16"/>',
    race:'<path d="M3.5 17 9 11.5l4 4 7.5-7.5"/><path d="M15 8h5.5v5.5"/>',
    players:'<circle cx="9" cy="8" r="3.5"/><path d="M2.8 20c.8-3.5 3.3-5.3 6.2-5.3s5.4 1.8 6.2 5.3"/><path d="M15.8 4.7a3.4 3.4 0 0 1 0 6.6M17.8 14.9c1.9.7 3 2.3 3.4 5.1"/>',
    matches:'<circle cx="12" cy="12" r="8.5"/><path d="M5.9 6c3.1 3.1 3.1 8.9 0 12M18.1 6c-3.1 3.1-3.1 8.9 0 12"/>',
    mymatches:'<ellipse cx="9.5" cy="9.5" rx="5.6" ry="6.4" transform="rotate(-45 9.5 9.5)"/><path d="m13.6 13.6 6.4 6.4"/><path d="M7 7.5l5 5M6.2 10.6l3.2 3.2M10.4 6.4l3.2 3.2"/>',
    events:'<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="12" cy="15" r="1.4"/>',
    fantasy:'<path d="M11 3.5l1.9 4.9 4.9 1.9-4.9 1.9L11 17.1l-1.9-4.9-4.9-1.9 4.9-1.9z"/><path d="M18.5 14.5l.8 2.1 2.2.9-2.2.8-.8 2.2-.9-2.2-2.1-.8 2.1-.9z"/>',
    partners:'<path d="M4 9.5 5.6 4.5h12.8L20 9.5"/><path d="M4 9.5c0 1.4 1.2 2.4 2.7 2.4s2.6-1 2.6-2.4c0 1.4 1.2 2.4 2.7 2.4s2.7-1 2.7-2.4c0 1.4 1.1 2.4 2.6 2.4S20 10.9 20 9.5"/><path d="M5.3 12v8.5h13.4V12"/><path d="M10 20.5V16h4v4.5"/>',
    tournaments:'<path d="M7 4h10v4.5a5 5 0 0 1-10 0z"/><path d="M7 5.5H4.5a3 3 0 0 0 3 4M17 5.5h2.5a3 3 0 0 1-3 4"/><path d="M12 13.5V17M8.5 20.5h7M10 17h4v3.5h-4z"/>',
    about:'<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/>',
    share:'<path d="M12 3.5v11"/><path d="m7.5 8 4.5-4.5L16.5 8"/><path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'
  };
  function icon(key,cls){
    var d=P[key];if(!d)return '';
    return '<svg class="'+(cls||'nvi')+'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';
  }
  var LABELS={
    ru:{home:'Главная',div:'Дивизионы',race:'Гонка',players:'Игроки',matches:'Матчи',mymatches:'Мои матчи',events:'События',fantasy:'Fantasy',partners:'Партнёры',tournaments:'Турниры',about:'О лиге'},
    en:{home:'Home',div:'Divisions',race:'Race',players:'Players',matches:'Matches',mymatches:'My matches',events:'Events',fantasy:'Fantasy',partners:'Partners',tournaments:'Tournaments',about:'About'}
  };
  // Где живёт вкладка: всё, кроме «Моих матчей», — на странице лиги. На сайте
  // лига открыта на главной (/), в Telegram — по адресу /league.
  function hrefFor(key,opts){
    opts=opts||{};
    var t=opts.token?('t='+encodeURIComponent(opts.token)):'';
    if(key==='mymatches')return '/match'+(t?'?'+t:'');
    var base=opts.web?'/':'/league';
    var qs=[key&&key!=='home'?'tab='+key:'',t].filter(Boolean).join('&');
    return base+(qs?'?'+qs:'');
  }
  w.PTFNav={icon:icon,labels:function(ru){return ru?LABELS.ru:LABELS.en},hrefFor:hrefFor};
})(window);
