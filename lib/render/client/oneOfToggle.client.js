// Mostra il ramo oneOf/anyOf/allOf selezionato e disabilita gli input negli altri.
// Pipeline: iniettato solo nelle pagine con un campo oneOf, così il motore generico di formEngine.client.js salta i rami nascosti.
function initOneOfToggles() {
  document.querySelectorAll('[data-oneof-switch]').forEach(function (select) {
    const groupName = select.dataset.oneofSwitch;
    function apply() {
      document.querySelectorAll('[data-oneof-branch="' + groupName + '"]').forEach(function (branch) {
        const active = branch.dataset.oneofValue === select.value;
        branch.style.display = active ? '' : 'none';
        branch.querySelectorAll('input, select, textarea').forEach(function (el) { el.disabled = !active; });
      });
    }
    select.addEventListener('change', apply);
    apply();
  });
}

initOneOfToggles();
