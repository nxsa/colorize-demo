<template>
  <UApp>
    <NuxtLoadingIndicator color="#113c5f" />
    <div>
      <NuxtRouteAnnouncer />
      <NuxtPage />
    </div>
  </UApp>
</template>

<style lang="css">
.page-enter-active,
.page-leave-active {
  transition: all 0.4s;
}

.page-enter-from,
.page-leave-to {
  opacity: 0;
}

.layout-enter-active,
.layout-leave-active {
  transition: all 0.4s;
}

.layout-enter-from,
.layout-leave-to {
  filter: grayscale(1);
}
</style>