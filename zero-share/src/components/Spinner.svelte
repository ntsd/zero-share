<div class="spinner">
  <div class="bar bg-primary" />
  <div class="bar bg-secondary" />
  <div class="bar bg-primary" />
</div>

<style>
  .spinner {
    display: inline-block;
    position: relative;
    width: 80px;
    height: 80px;
  }
  .bar {
    display: inline-block;
    position: absolute;
    width: 16px;
    animation: bounce 1.2s cubic-bezier(0, 0.5, 0.5, 1) infinite;
  }
  .bar:nth-child(1) {
    left: 8px;
    animation-delay: -0.24s;
  }
  .bar:nth-child(2) {
    left: 32px;
    animation-delay: -0.12s;
  }
  .bar:nth-child(3) {
    left: 56px;
    animation-delay: 0;
  }
  @keyframes bounce {
    0% {
      top: 8px;
      height: 64px;
    }
    50%,
    100% {
      top: 24px;
      height: 32px;
    }
  }
</style>
