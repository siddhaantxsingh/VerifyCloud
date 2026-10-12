// Testbench for axil_regs. Self-checking: a reference model predicts every
// read; protocol rules are checked by axil_checker (SVA).
//
// Plusargs:
//   +TEST=<smoke|reset|wstrb|random|error_injection>
//   +SEED=<n>        seed for all randomization (deterministic)
//   +OPS=<n>         number of random operations (random test, default 400)
//
// Output protocol (parsed by VerifyCloud):
//   VC_TEST_START test=<name> seed=<n>
//   VC_RESULT PASS                 or   VC_RESULT FAIL errors=<n>
// A failing test also ends with $fatal (non-zero exit status).
`timescale 1ns/1ps
module tb_top;
  localparam int ADDR_W = 8;

  logic aclk = 1'b0;
  logic aresetn = 1'b1;   // driven low at time 0 by the main process
  always #5 aclk = ~aclk;   // 100 MHz

  logic [ADDR_W-1:0] awaddr = '0;  logic awvalid = 1'b0; logic awready;
  logic [31:0] wdata = '0; logic [3:0] wstrb = '0; logic wvalid = 1'b0; logic wready;
  logic [1:0]  bresp; logic bvalid; logic bready = 1'b0;
  logic [ADDR_W-1:0] araddr = '0;  logic arvalid = 1'b0; logic arready;
  logic [31:0] rdata; logic [1:0] rresp; logic rvalid; logic rready = 1'b0;

  axil_regs #(.ADDR_W(ADDR_W)) dut (.*);
  axil_checker #(.ADDR_W(ADDR_W)) chk (.*);

  // ---------------- reference model ----------------
  logic [31:0] model [4];
  int errors = 0;
  int seed = 1;
  string test = "smoke";

  function automatic void model_reset();
    model[0] = 32'h0; model[1] = 32'h0; model[2] = 32'h0; model[3] = 32'hA5A5_0000;
  endfunction

  function automatic logic [33:0] model_read(logic [ADDR_W-1:0] a);
    if (a[1:0] != 2'b00) return {2'b10, 32'h0};
    if (a[ADDR_W-1:4] == '0) return {2'b00, model[a[3:2]]};
    if (a == 8'h10) return {2'b00, 32'h5643_0001};
    return {2'b10, 32'h0};
  endfunction

  function automatic logic [1:0] model_write(logic [ADDR_W-1:0] a, logic [31:0] d, logic [3:0] s);
    if (a[ADDR_W-1:4] == '0 && a[1:0] == 2'b00) begin
      for (int b = 0; b < 4; b++) if (s[b]) model[a[3:2]][8*b +: 8] = d[8*b +: 8];
      return 2'b00;
    end
    return 2'b10;
  endfunction

  function automatic void fail(string msg);
    errors++;
    $display("VC_CHECK FAIL time=%0t %s", $time, msg);
  endfunction

  // ---------------- driver tasks ----------------
  // The testbench drives and samples only at the FALLING clock edge with
  // blocking assignments; the DUT samples at the rising edge. Ready signals of
  // this DUT depend only on its registers, so "valid && ready" evaluated at
  // the falling edge is exactly the handshake that happens at the next rising
  // edge. This keeps the testbench free of races with the DUT.
  int max_delay = 0;   // random handshake delays (0 = none)

  task automatic idle(int n);
    repeat (n) @(negedge aclk);
  endtask

  function automatic int rnd_delay();
    return max_delay == 0 ? 0 : int'($urandom_range(max_delay, 0));
  endfunction

  // AW and W are driven from one process with independent random start
  // delays, so either channel may be accepted first.
  task automatic axi_write(logic [ADDR_W-1:0] a, logic [31:0] d, logic [3:0] s, output logic [1:0] resp);
    int d_aw = rnd_delay(), d_w = rnd_delay(), d_b = rnd_delay();
    bit aw_done = 0, w_done = 0, aw_hs, w_hs, b_hs;
    int cyc = 0;
    @(negedge aclk);
    while (!(aw_done && w_done)) begin
      if (!aw_done && cyc == d_aw) begin awaddr = a; awvalid = 1'b1; end
      if (!w_done && cyc == d_w) begin wdata = d; wstrb = s; wvalid = 1'b1; end
      aw_hs = awvalid && awready;
      w_hs  = wvalid && wready;
      @(negedge aclk);                       // the rising edge in between performs the handshake
      if (aw_hs) begin aw_done = 1; awvalid = 1'b0; end
      if (w_hs)  begin w_done = 1;  wvalid  = 1'b0; end
      cyc++;
    end
    idle(d_b);
    bready = 1'b1;
    do begin
      b_hs = bvalid && bready;
      resp = bresp;
      @(negedge aclk);
    end while (!b_hs);
    bready = 1'b0;
  endtask

  // next_addr: what the master drives on ARADDR after the handshake. A real
  // master may present its next address early; the slave must not care.
  task automatic axi_read(logic [ADDR_W-1:0] a, logic [ADDR_W-1:0] next_addr,
                          output logic [31:0] d, output logic [1:0] resp);
    bit hs;
    @(negedge aclk);
    idle(rnd_delay());
    araddr = a; arvalid = 1'b1;
    do begin
      hs = arvalid && arready;
      @(negedge aclk);
    end while (!hs);
    arvalid = 1'b0;
    // Back-pressure on R for a random number of cycles; after the first
    // cycle the master already presents its next address on ARADDR.
    begin
      int bp = rnd_delay();
      for (int i = 0; i < bp; i++) begin
        @(negedge aclk);
        if (i == 0) araddr = next_addr;
      end
      if (bp == 0) araddr = next_addr;
    end
    rready = 1'b1;
    do begin
      hs = rvalid && rready;
      d = rdata; resp = rresp;
      @(negedge aclk);
    end while (!hs);
    rready = 1'b0;
  endtask

  task automatic check_write(logic [ADDR_W-1:0] a, logic [31:0] d, logic [3:0] s);
    logic [1:0] resp, exp;
    exp = model_write(a, d, s);
    axi_write(a, d, s, resp);
    if (resp !== exp) fail($sformatf("write addr=0x%02h: BRESP=%0d expected %0d", a, resp, exp));
  endtask

  task automatic check_read(logic [ADDR_W-1:0] a, logic [ADDR_W-1:0] next_addr = '0);
    logic [31:0] d; logic [1:0] resp; logic [33:0] exp;
    exp = model_read(a);
    axi_read(a, next_addr, d, resp);
    if (resp !== exp[33:32]) fail($sformatf("read addr=0x%02h: RRESP=%0d expected %0d", a, resp, exp[33:32]));
    else if (d !== exp[31:0]) fail($sformatf("read addr=0x%02h: RDATA=0x%08h expected 0x%08h", a, d, exp[31:0]));
  endtask

  // ---------------- tests ----------------
  task automatic t_smoke();
    for (int i = 0; i < 4; i++) check_write(ADDR_W'(i*4), 32'h1000_0000 + 32'(i), 4'hF);
    for (int i = 0; i < 4; i++) check_read(ADDR_W'(i*4), ADDR_W'(i*4));
    check_read(8'h10, 8'h10);
  endtask

  task automatic t_reset();
    for (int i = 0; i < 4; i++) check_read(ADDR_W'(i*4), ADDR_W'(i*4));
    check_write(8'h04, 32'hDEAD_BEEF, 4'hF);
    // reset in the middle of operation
    aresetn = 1'b0; idle(3); aresetn = 1'b1; idle(2);
    model_reset();
    for (int i = 0; i < 4; i++) check_read(ADDR_W'(i*4), ADDR_W'(i*4));
  endtask

  task automatic t_wstrb();
    check_write(8'h08, 32'h0000_0000, 4'hF);
    for (int s = 1; s < 16; s++) begin
      check_write(8'h08, $urandom(), 4'(s));
      check_read(8'h08, 8'h08);
    end
  endtask

  task automatic t_random(int ops);
    max_delay = 3;
    for (int i = 0; i < ops; i++) begin
      logic [ADDR_W-1:0] a;
      int kind = int'($urandom_range(9, 0));
      // mostly mapped registers, sometimes ID / unmapped / misaligned
      case ($urandom_range(9, 0))
        0: a = 8'h10;
        1: a = ADDR_W'($urandom_range(255, 0));
        default: a = ADDR_W'($urandom_range(3, 0) * 4);
      endcase
      if (kind < 4) check_write(a, $urandom(), 4'($urandom_range(15, 0)));
      else check_read(a, ADDR_W'($urandom_range(3, 0) * 4));
    end
  endtask

  task automatic t_error_injection();
    logic [ADDR_W-1:0] bad [5] = '{8'h14, 8'h20, 8'hFC, 8'h02, 8'h07};
    foreach (bad[i]) begin
      check_write(bad[i], 32'hBAD0_0000 + 32'(i), 4'hF);
      check_read(bad[i], bad[i]);
    end
    check_write(8'h10, 32'hFFFF_FFFF, 4'hF);    // ID is read-only
    check_read(8'h10, 8'h10);
    for (int i = 0; i < 4; i++) check_read(ADDR_W'(i*4), ADDR_W'(i*4)); // nothing was corrupted
  endtask

  // A write to the register being read lands while the master holds off R.
  // The read was accepted first, so RDATA must be the value at the AR
  // handshake and must not change while RVALID waits for RREADY.
  // The two branches wait with inline repeat loops: with Verilator 5.020,
  // concurrent calls of idle() from both branches returned early in this
  // testbench (12 + 3 cycles elapsed in about 7), so the write never landed
  // during the stall and the test passed vacuously. Not reproduced in a
  // standalone example; the inline form avoids the question entirely.
  task automatic t_rw_overlap();
    for (int r = 0; r < 4; r++) begin
      logic [ADDR_W-1:0] a; logic [31:0] d; logic [1:0] resp, wresp, wexp; logic [33:0] exp; bit hs;
      a = ADDR_W'(r * 4);
      exp = model_read(a);
      fork
        begin
          @(negedge aclk); araddr = a; arvalid = 1'b1;
          do begin hs = arvalid && arready; @(negedge aclk); end while (!hs);
          arvalid = 1'b0;
          repeat (12) @(negedge aclk);
          rready = 1'b1;
          do begin hs = rvalid && rready; d = rdata; resp = rresp; @(negedge aclk); end while (!hs);
          rready = 1'b0;
        end
        begin
          repeat (3) @(negedge aclk);
          wexp = model_write(a, 32'hC0DE_0000 + 32'(r), 4'hF);
          axi_write(a, 32'hC0DE_0000 + 32'(r), 4'hF, wresp);
          if (wresp !== wexp) fail($sformatf("overlapped write addr=0x%02h: BRESP=%0d", a, wresp));
        end
      join
      if (d !== exp[31:0]) fail($sformatf("overlapped read addr=0x%02h: RDATA=0x%08h expected 0x%08h (value at the AR handshake)", a, d, exp[31:0]));
      check_read(a);  // and the write took effect
    end
  endtask

  // ---------------- main ----------------
  initial begin
    int ops = 400;
    void'($value$plusargs("TEST=%s", test));
    void'($value$plusargs("SEED=%d", seed));
    void'($value$plusargs("OPS=%d", ops));
    void'($urandom(seed));
    $display("VC_TEST_START test=%s seed=%0d", test, seed);
    model_reset();
    aresetn = 1'b0; idle(2); aresetn = 1'b1; idle(2);
    case (test)
      "smoke":           t_smoke();
      "reset":           t_reset();
      "wstrb":           t_wstrb();
      "random":          t_random(ops);
      "error_injection": t_error_injection();
      "rw_overlap":      t_rw_overlap();
      default: begin $display("VC_CHECK FAIL unknown test '%s'", test); errors++; end
    endcase
    idle(5);
    if (errors == 0) begin
      $display("VC_RESULT PASS");
      $finish;
    end else begin
      $display("VC_RESULT FAIL errors=%0d", errors);
      $fatal(1, "test %s failed with %0d error(s)", test, errors);
    end
  end

  // global watchdog: a hung handshake must not hang the simulator
  initial begin
    #2ms;
    $display("VC_RESULT FAIL errors=watchdog");
    $fatal(1, "watchdog: simulation did not finish in 2 ms of simulated time");
  end

  // waveform dump when enabled with +TRACE (Verilator --trace / --trace-fst)
  initial begin
    if ($test$plusargs("TRACE")) begin
      $dumpfile("waves.vcd");
      $dumpvars(0, tb_top);
    end
  end
endmodule
