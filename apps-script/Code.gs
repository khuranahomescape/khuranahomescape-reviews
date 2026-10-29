// Mail relay, runs inside the khuranahomescape@gmail.com Google account (Google Apps Script web app).
// The Worker POSTs {secret,to,subject,html}; this sends it from that Gmail account to itself.
var SECRET = 'PASTE_MAIL_SECRET';
function doPost(e) {
  var d = JSON.parse(e.postData.contents);
  if (d.secret !== SECRET) return ContentService.createTextOutput('forbidden');
  MailApp.sendEmail({to: Session.getEffectiveUser().getEmail(), subject: d.subject, htmlBody: d.html, name: 'khuranahomescape moderation'});
  return ContentService.createTextOutput('ok');
}
