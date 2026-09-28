// Общие настройки экрана для всех мини-приложений: тема и язык.
//
// Тема хранится на устройстве (ptf_theme) — так было и раньше в лиге и матчах.
// Язык хранится на устройстве (ptf_lang) и дополнительно уходит на сервер в
// анкету игрока: тогда и бот, и тексты ошибок сервера говорят на том же языке.
//
// Кто главнее при открытии экрана:
//   1) язык из анкеты (сервер говорит lang_source: 'profile') — его выбрали
//      сознательно, в боте или этим же переключателем;
//   2) выбор на этом устройстве — для тех, у кого анкеты ещё нет;
//   3) язык Telegram.
(function(w,d){
  var TK='ptf_theme',LK='ptf_lang';
  var BG={dark:'#0A0A0B',light:'#F2F5F1'};
  var tg=w.Telegram&&w.Telegram.WebApp;
  function get(k){try{return w.localStorage.getItem(k)||''}catch(e){return ''}}
  function put(k,v){try{w.localStorage.setItem(k,v)}catch(e){}}
  function tgLang(){
    var code=(tg&&tg.initDataUnsafe&&tg.initDataUnsafe.user&&tg.initDataUnsafe.user.language_code)||'';
    return String(code).toLowerCase().indexOf('ru')===0?'ru':'en';
  }
  function savedLang(){var v=get(LK);return v==='ru'||v==='en'?v:''}

  var theme=get(TK)==='light'?'light':'dark';
  var lang=savedLang()||tgLang();
  var mounts=[];

  function paintTheme(){
    d.documentElement.setAttribute('data-theme',theme);
    try{if(tg&&tg.setHeaderColor)tg.setHeaderColor(BG[theme])}catch(e){}
    try{if(tg&&tg.setBackgroundColor)tg.setBackgroundColor(BG[theme])}catch(e){}
  }
  // Сразу при подключении: страница не мигает тёмной перед светлой.
  paintTheme();

  function setTheme(v){theme=v==='light'?'light':'dark';put(TK,theme);paintTheme();sync()}
  function resolveLang(j){
    j=j||{};
    var s=j.lang==='ru'||j.lang==='en'?j.lang:'';
    if(s&&j.lang_source==='profile'){lang=s;put(LK,s)}
    else lang=savedLang()||s||tgLang();
    d.documentElement.lang=lang;sync();
    return lang;
  }
  // Промис всегда завершается (и при ошибке, и по таймауту): экран, который
  // после смены языка перезагружается, ждёт записи в анкету, иначе свежая
  // загрузка успеет прочитать старый язык.
  var saving=Promise.resolve();
  function persist(v){
    saving=new Promise(function(done){
      var timer=setTimeout(done,2500);
      try{
        var t=new URLSearchParams(location.search).get('t')||'';
        fetch('/api/ui-language',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({initData:(tg&&tg.initData)||'',t:t,lang:v})})
          .catch(function(){}).then(function(){clearTimeout(timer);done()});
      }catch(e){clearTimeout(timer);done()}
    });
    return saving;
  }
  function setLang(v){
    lang=v==='ru'?'ru':'en';put(LK,lang);d.documentElement.lang=lang;persist(lang);sync();
    return lang;
  }

  // Базовый вид переключателя — через :where(), чтобы у страниц со своим
  // оформлением (лига, матчи) побеждали их собственные правила.
  function injectCss(){
    if(d.getElementById('ptfPrefsCss'))return;
    var s=d.createElement('style');s.id='ptfPrefsCss';
    s.textContent=':where(.thsw){display:flex;gap:3px;padding:3px;border:1px solid var(--line,var(--border,#2A2521));'
      +'border-radius:999px;background:var(--card,var(--surf,#111010));flex:0 0 auto}'
      +':where(.thsw) :where(button){width:27px;height:24px;border:0;border-radius:999px;background:transparent;'
      +'color:var(--muted,var(--mute,#8A7F6F));font-size:13px;line-height:1;cursor:pointer;padding:0;display:flex;'
      +'align-items:center;justify-content:center;font-family:inherit;margin:0;min-height:0;min-width:0}'
      +':where(.thsw) :where(button.on){background:var(--accBg,rgba(232,164,92,.12));color:var(--accent,var(--amber,#E8A45C));'
      +'box-shadow:0 0 0 1px var(--accLine,rgba(232,164,92,.34)) inset}'
      +'.thsw button.lg{width:auto;padding:0 8px;font-size:11px;font-weight:800;letter-spacing:.04em;'
      +'margin-left:3px;box-shadow:-1px 0 0 0 var(--line,var(--border,#2A2521))}';
    (d.head||d.documentElement).appendChild(s);
  }

  function draw(m){
    var h='<button type="button" data-th="dark" title="Dark">☾</button>'
      +'<button type="button" data-th="light" title="Light">☀</button>';
    if(m.lang)h+='<button type="button" class="lg" data-lg="1"></button>';
    m.el.innerHTML=h;
    [].forEach.call(m.el.querySelectorAll('button[data-th]'),function(b){
      b.onclick=function(){setTheme(b.getAttribute('data-th'))};
    });
    var lg=m.el.querySelector('button[data-lg]');
    if(lg)lg.onclick=function(){
      var next=setLang(lang==='ru'?'en':'ru');
      if(typeof m.onLang==='function')m.onLang(next,saving);
    };
  }
  function sync(){
    mounts.forEach(function(m){
      if(!m.el||!m.el.isConnected)return;
      [].forEach.call(m.el.querySelectorAll('button[data-th]'),function(b){
        b.classList.toggle('on',b.getAttribute('data-th')===theme);
      });
      var lg=m.el.querySelector('button[data-lg]');
      // На кнопке — язык, на который переключимся, как в Fantasy.
      if(lg){lg.textContent=lang==='ru'?'EN':'RU';lg.title=lang==='ru'?'Switch to English':'Переключить на русский'}
    });
  }
  // el — контейнер .thsw; opts.lang — показывать ли RU/EN; opts.onLang(lang,
  // saved) — что сделать на экране после смены языка; saved — промис записи
  // в анкету (его ждут экраны, которые перезагружаются).
  function mount(el,opts){
    if(!el)return;
    opts=opts||{};
    injectCss();
    if(!el.classList.contains('thsw'))el.classList.add('thsw');
    var m={el:el,lang:opts.lang!==false,onLang:opts.onLang};
    mounts=mounts.filter(function(x){return x.el!==el});
    mounts.push(m);draw(m);sync();
  }

  w.PTFPrefs={
    theme:function(){return theme},setTheme:setTheme,
    lang:function(){return lang},setLang:setLang,resolveLang:resolveLang,
    saved:function(){return saving},
    mount:mount
  };
})(window,document);
